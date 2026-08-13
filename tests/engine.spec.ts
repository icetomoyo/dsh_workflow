import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import { createWorkflowCapsule, validateWorkflowManifest } from '../src/capsule.js'
import { DynamicWorkflowEngine, WorkflowSemaphore, resolveReadOnlyToolFilter } from '../src/engine.js'
import { WorkflowRunStore } from '../src/store.js'
import type { ResolvedWorkflowConfig, WorkflowDispatchAdapter, WorkflowModule, WorkflowStartInput } from '../src/types.js'
import type { WorkflowVerificationAdapter, WorktreeIsolationAdapter } from '../src/types.js'

function parent(cwd: string): Agent {
  return { session: { header: { cwd }, events: [], append: vi.fn() }, ctx: { tools: { schemas: () => [{ name: 'read' }, { name: 'write' }, { name: 'shell' }] } } } as unknown as Agent
}

function config(overrides: Partial<ResolvedWorkflowConfig> = {}): ResolvedWorkflowConfig {
  return {
    projectDirectory: '.dsh/workflows', personalDirectory: 'workflows', runDirectory: '.dsh/workflow-runs',
    maxCapsuleBytes: 512_000, maxCatalogEntries: 200, maxAgents: 8, maxConcurrency: 4,
    maxResultChars: 10_000, scriptSyncTimeoutMs: 100, scriptWallTimeoutMs: 2_000,
    defaultProvider: 'spawn', synthesisProvider: 'spawn',
    modelTiers: {
      fast: { subagentProvider: 'spawn', provider: 'mock-llm', model: 'fast-model', maxTokens: 10 },
      balanced: { subagentProvider: 'spawn', provider: 'mock-llm', model: 'balanced-model', maxTokens: 20 },
      deep: { subagentProvider: 'spawn', provider: 'mock-llm', model: 'deep-model', maxTokens: 30 },
    },
    readOnlyToolFilter: { deny: ['write', 'shell'] }, approvalMode: 'never',
    availableTools: ['read'], availableMcp: ['docs'], availableSkills: ['review'],
    maxRetainedRuns: 20, pluginVersion: '0.1.0', dshVersion: '0.0.1-rc.2', ...overrides,
  }
}

function module(source: string, overrides: Record<string, unknown> = {}): WorkflowModule {
  const manifest = validateWorkflowManifest({
    name: 'engine-test', description: 'Exercise the workflow engine.', phases: ['work', 'verify'],
    readOnly: true, maxAgents: 8, maxConcurrency: 4, patterns: ['fan-out-and-synthesize'], ...overrides,
  })
  const capsule = createWorkflowCapsule({ minDshVersion: '0.0.1-rc.2', manifest, source })
  return { manifest, execution: 'capability-generated', source, capsule }
}

interface FakeSubagents {
  readonly service: SubagentRuntime
  readonly starts: ReturnType<typeof vi.fn<(provider: string, request: SubagentStartRequest) => Promise<unknown>>>
}

function subagents(handler?: (provider: string, request: SubagentStartRequest, index: number) => Promise<{ output: { type: 'text'; text: string }[]; structured?: unknown; stopReason: 'completed' | 'error' | 'aborted' }>, initialLocalAgent?: Agent): FakeSubagents {
  let index = 0
  const starts = vi.fn(async (provider: string, request: SubagentStartRequest) => {
    const current = ++index
    const result = handler === undefined
      ? Promise.resolve({ output: [{ type: 'text' as const, text: `result-${current}` }], stopReason: 'completed' as const })
      : handler(provider, request, current)
    return { id: `child-${current}`, localAgent: current === 1 ? initialLocalAgent : undefined, result, dispose: vi.fn(async () => {}) }
  })
  return {
    starts,
    service: {
      getProvider: (name: string) => name === 'spawn' ? { name, capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, inheritsParentContext: false } : undefined,
      start: starts,
    } as unknown as SubagentRuntime,
  }
}

async function fixture(options: {
  readonly source: string
  readonly manifest?: Record<string, unknown>
  readonly config?: Partial<ResolvedWorkflowConfig>
  readonly fake?: FakeSubagents
  readonly resolveNested?: (name: string) => Promise<{ module: WorkflowModule; source: WorkflowStartInput['source'] }>
  readonly approval?: { request(): Promise<'allowed-once' | 'denied'> }
  readonly verification?: WorkflowVerificationAdapter
  readonly isolation?: WorktreeIsolationAdapter
  readonly deploymentSemaphore?: WorkflowSemaphore
  readonly dispatch?: WorkflowDispatchAdapter
}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-workflow-engine-'))
  const fake = options.fake ?? subagents()
  const store = new WorkflowRunStore(join(cwd, 'runs'))
  let sequence = 0
  const engine = new DynamicWorkflowEngine({
    subagents: fake.service, config: config(options.config), store,
    resolveNested: options.resolveNested ?? (async () => { throw new Error('nested workflow not found') }),
    ...(options.approval === undefined ? {} : { approval: options.approval as never }),
    ...(options.verification === undefined ? {} : { verification: options.verification }),
    ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
    ...(options.deploymentSemaphore === undefined ? {} : { deploymentSemaphore: options.deploymentSemaphore }),
    ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
    id: () => `run-${++sequence}`,
  })
  return { cwd, parent: parent(cwd), fake, store, engine, module: module(options.source, options.manifest) }
}

describe('dynamic workflow engine', () => {
  it('routes models, enforces read-only tools, emits a durable graph, and returns artifacts', async () => {
    const fake = subagents(async (_provider, _request, index) => index === 3
      ? { output: [{ type: 'text', text: '{}' }], structured: {}, stopReason: 'completed' }
      : { output: [{ type: 'text', text: `result-${index}` }], stopReason: 'completed' })
    const fx = await fixture({ fake, source: `async function run(wf, args) {
      return await wf.phase('work', async () => {
        const values = await wf.parallel([
          async () => await wf.runAgent({ name: 'fast', prompt: 'one', modelHint: 'fast' }),
          async () => await wf.runAgent({ name: 'deep', prompt: 'two', modelHint: 'deep', outputSchema: { type: 'object', additionalProperties: true } })
        ], { concurrency: 2 });
        const artifact = await wf.artifact('evidence', values);
        return { values, artifact };
      });
    }` })
    const observed: string[] = []
    const unsubscribe = fx.engine.subscribe(event => { observed.push(event.type) })
    const run = await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent, args: {} })
    const result = await run.done
    expect(result.status).toBe('completed')
    expect(result.cost).toMatchObject({ agentsStarted: 2, agentsCompleted: 2, peakConcurrency: 2, tokenUsage: 0 })
    expect(result.artifacts).toHaveLength(1)
    expect(result.process).toMatchObject({ progress: { spawnedAgents: 2, finishedAgents: 2 } })
    expect(result.process?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'phase', title: 'work', status: 'completed' }),
      expect.objectContaining({ kind: 'phase', title: 'verify', status: 'skipped' }),
      expect.objectContaining({ kind: 'agent', phaseId: 'phase:1', childAgentId: 'child-1' }),
      expect.objectContaining({ kind: 'artifact', title: 'evidence' }),
    ]))
    expect(result.outcome).toMatchObject({ status: 'completed', results: [{ summary: 'result-1', artifacts: [] }, { summary: 'result-2', artifacts: [] }], usage: { totalSpawned: 2 } })
    expect(fx.fake.starts).toHaveBeenCalledTimes(3)
    expect(fx.fake.starts.mock.calls[0]).toMatchObject(['spawn', { toolFilter: { allow: ['read'] }, agentOptions: { provider: 'mock-llm', model: 'fast-model', maxTokens: 10 } }])
    expect(fx.store.getEvents(run.runId).map(event => event.type)).toEqual(expect.arrayContaining(['workflow-started', 'phase-started', 'agent-started', 'agent-completed', 'artifact-written', 'workflow-completed']))
    expect(observed).toContain('workflow-completed')
    unsubscribe()
  })

  it('builds a fail-closed read-only allow-list from the real visible catalog shape', () => {
    const value = parent('C:\\workspace')
    expect(resolveReadOnlyToolFilter(value, ['read', 'missing', 'run_code', 'write'], ['write'])).toEqual({ allow: ['read'] })
    expect(resolveReadOnlyToolFilter(value, ['missing'])).toEqual({ allow: [] })
  })

  it('never allows a child to weaken a read-only workflow manifest', async () => {
    const fx = await fixture({ source: `async function run(wf, args) {
      return await wf.runAgent({ name: 'writer', prompt: 'write a file', readOnly: false });
    }` })
    const result = await (await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })).done
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('readOnly=true') })
    expect(fx.fake.starts).not.toHaveBeenCalled()
  })

  it('rejects malformed generated task metadata before provider dispatch', async () => {
    const fx = await fixture({ source: `async function run(wf, args) {
      return await wf.runAgent({ name: 'bad-route', prompt: 'inspect', modelHint: 'unknown-tier' });
    }` })
    const result = await (await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })).done
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('modelHint') })
    expect(fx.fake.starts).not.toHaveBeenCalled()
  })

  it('routes target and effort through an explicit deployment dispatch adapter', async () => {
    const fake = subagents()
    const dispatch: WorkflowDispatchAdapter = { start: vi.fn(async input => await input.subagents.start(input.provider, input.request)) }
    const fx = await fixture({ fake, dispatch, source: `async function run(wf, args) { return await wf.runAgent({ name: 'targeted', prompt: 'continue', target: { agentId: 'agent-1', expectedConfigurationRevision: 'r2' }, effort: 'high' }); }` })
    expect(await (await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })).done).toMatchObject({ status: 'completed' })
    expect(dispatch.start).toHaveBeenCalledWith(expect.objectContaining({ target: { agentId: 'agent-1', expectedConfigurationRevision: 'r2' }, effort: 'high', provider: 'spawn' }))
    const unsupported = await fixture({ source: `async function run(wf, args) { return await wf.runAgent({ name: 'targeted', prompt: 'continue', target: { agentId: 'agent-1' } }); }` })
    expect(await (await unsupported.engine.start({ module: unsupported.module, source: 'inline', parent: unsupported.parent })).done).toMatchObject({ status: 'failed', error: expect.stringContaining('dispatch adapter') })
  })

  it('returns null from runAgent for terminal child failure while wait retains the result', async () => {
    const failed = subagents(async () => ({ output: [{ type: 'text', text: 'partial diagnosis' }], stopReason: 'error' }))
    const fx = await fixture({ fake: failed, source: `async function run(wf, args) {
      const handle = await wf.spawnAgent({ name: 'audited', prompt: 'inspect' });
      const waited = await wf.wait(handle.taskId);
      const lenient = await wf.runAgent({ name: 'optional', prompt: 'inspect' });
      return { waited, lenient };
    }` })
    const result = await (await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })).done
    expect(result.result).toMatchObject({ waited: { status: 'failed', finalText: 'partial diagnosis' }, lenient: null })
    expect(result.outcome).toMatchObject({ status: 'partial', unresolved: ['audited', 'optional'] })
  })

  it('repairs missing structured output exactly once with the same route and no tools', async () => {
    const fake = subagents(async (_provider, _request, index) => index === 1
      ? { output: [{ type: 'text', text: 'analysis without JSON' }], stopReason: 'completed' }
      : { output: [{ type: 'text', text: '```json\n{"answer":"fixed"}\n```' }], structured: { answer: 'fixed' }, stopReason: 'completed' })
    const dispatch: WorkflowDispatchAdapter = {
      start: vi.fn(async input => ({ run: await input.subagents.start(input.provider, input.request), telemetry: { resolvedEffort: input.effort } })),
    }
    const fx = await fixture({ fake, dispatch, source: `async function run(wf, args) { return await wf.runAgent({
      name: 'structured', prompt: 'answer', modelHint: 'deep', effort: 'high',
      outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false }
    }); }` })
    const result = await (await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })).done
    expect(result.result).toMatchObject({ structured: { answer: 'fixed' }, requestedTier: 'deep', tierOutcome: 'applied', resolvedEffort: 'high' })
    expect(fake.starts).toHaveBeenCalledTimes(2)
    expect(fake.starts.mock.calls[1]).toMatchObject(['spawn', { toolFilter: { allow: [] }, agentOptions: { provider: 'mock-llm', model: 'deep-model' } }])
    expect(dispatch.start).toHaveBeenCalledTimes(2)
  })

  it('repairs the real rc.2 error shape when native structured capture is missing', async () => {
    const localAgent = { session: { events: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'step/end', seq: 2, time: 3, data: { turn: 1, step: 1, reason: { kind: 'completed' } } },
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ] } } as unknown as Agent
    const fake = subagents(async (_provider, _request, index) => index === 1
      ? { output: [{ type: 'text', text: 'completed report without native capture' }], stopReason: 'error' }
      : { output: [{ type: 'text', text: '{"answer":"recovered"}' }], stopReason: 'completed' }, localAgent)
    const fx = await fixture({ fake, source: `async function run(wf, args) { return await wf.runAgent({
      name: 'rc2-structured', prompt: 'answer',
      outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false }
    }); }` })
    const result = await (await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })).done
    expect(result).toMatchObject({ status: 'completed', result: { status: 'completed', structured: { answer: 'recovered' }, stopReason: 'completed-after-structured-repair' } })
    expect(fake.starts).toHaveBeenCalledTimes(2)
  })

  it('does not promote an ordinary provider error or an unsuccessful structured repair', async () => {
    const ordinary = subagents(async () => ({ output: [{ type: 'text', text: '{"answer":"not-success"}' }], stopReason: 'error' }))
    const ordinaryFx = await fixture({ fake: ordinary, source: `async function run(wf, args) { return await wf.runAgent({ name: 'ordinary-error', prompt: 'answer', outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } }); }` })
    const ordinaryResult = await (await ordinaryFx.engine.start({ module: ordinaryFx.module, source: 'inline', parent: ordinaryFx.parent })).done
    expect(ordinaryResult).toMatchObject({ status: 'completed', result: null, outcome: { status: 'partial' } })
    expect(ordinary.starts).toHaveBeenCalledTimes(1)

    const localAgent = { session: { events: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'step/end', seq: 2, time: 3, data: { turn: 1, step: 1, reason: { kind: 'completed' } } },
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ] } } as unknown as Agent
    const failedRepair = subagents(async (_provider, _request, index) => index === 1
      ? { output: [{ type: 'text', text: 'missing capture' }], stopReason: 'error' }
      : { output: [{ type: 'text', text: '{"answer":"looks-valid"}' }], stopReason: 'error' }, localAgent)
    const repairFx = await fixture({ fake: failedRepair, source: `async function run(wf, args) { return await wf.runAgent({ name: 'failed-repair', prompt: 'answer', outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } }); }` })
    const repairResult = await (await repairFx.engine.start({ module: repairFx.module, source: 'inline', parent: repairFx.parent })).done
    expect(repairResult).toMatchObject({ status: 'completed', result: null, outcome: { status: 'partial', errors: [{ message: expect.stringContaining('structured repair child stopped with error') }] } })
    expect(failedRepair.starts).toHaveBeenCalledTimes(2)
  })

  it('fails required structured output when the single repair is still schema-invalid', async () => {
    const fake = subagents(async (_provider, _request, index) => index === 1
      ? { output: [{ type: 'text', text: '{"wrong":true}' }], stopReason: 'completed' }
      : { output: [{ type: 'text', text: '{"wrong":"again"}' }], stopReason: 'completed' })
    const fx = await fixture({ fake, source: `async function run(wf, args) { return await wf.runAgent({
      name: 'invalid-structured', prompt: 'answer',
      outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false }
    }); }` })
    const result = await (await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })).done
    expect(result).toMatchObject({ status: 'completed', result: null, outcome: { status: 'partial', errors: [{ message: expect.stringContaining('structured output validation failed') }] } })
    expect(result.outcome?.results[0]).toMatchObject({ status: 'failed' })
    expect(result.outcome?.results[0]).not.toHaveProperty('structured')
    expect(fake.starts).toHaveBeenCalledTimes(2)
  })

  it('rejects unsupported schemas and unresolved evidence references before dispatch', async () => {
    const invalidSchema = await fixture({ source: `async function run(wf, args) { return await wf.runAgent({ name: 'bad-schema', prompt: 'x', outputSchema: { type: 'object', minProperties: 1 } }); }` })
    expect(await (await invalidSchema.engine.start({ module: invalidSchema.module, source: 'inline', parent: invalidSchema.parent })).done).toMatchObject({ status: 'failed', error: expect.stringContaining('outputSchema') })
    expect(invalidSchema.fake.starts).not.toHaveBeenCalled()

    const invalidRef = await fixture({ source: `async function run(wf, args) { return await wf.runAgent({ name: 'bad-ref', prompt: 'x', evidenceRefs: ['issue:1'] }); }` })
    expect(await (await invalidRef.engine.start({ module: invalidRef.module, source: 'inline', parent: invalidRef.parent })).done).toMatchObject({ status: 'failed', error: expect.stringContaining('file:, diff:, finding:, or task_id:') })
    const unknownTask = await fixture({ source: `async function run(wf, args) { return await wf.runAgent({ name: 'bad-task', prompt: 'x', evidenceRefs: ['task_id:task-999'] }); }` })
    expect(await (await unknownTask.engine.start({ module: unknownTask.module, source: 'inline', parent: unknownTask.parent })).done).toMatchObject({ status: 'failed', error: expect.stringContaining('unknown workflow task id') })
  })

  it('accepts evidence task ids already registered in the same run', async () => {
    const fx = await fixture({ source: `async function run(wf, args) {
      const first = await wf.spawnAgent({ name: 'first', prompt: 'inspect' });
      const second = await wf.runAgent({ name: 'second', prompt: 'use evidence', evidenceRefs: ['task_id:' + first.taskId] });
      await wf.wait(first.taskId);
      return second;
    }` })
    expect(await (await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })).done).toMatchObject({ status: 'completed' })
    expect(fx.fake.starts).toHaveBeenCalledTimes(2)
  })

  it('keeps fast-tier routing read-only and exposes route facts without inventing usage', async () => {
    const fx = await fixture({ manifest: { readOnly: false }, source: `async function run(wf, args) { return await wf.runAgent({ name: 'writer', prompt: 'write', readOnly: false, modelHint: 'fast' }); }` })
    const result = await (await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })).done
    expect(result.result).toMatchObject({ requestedTier: 'fast', tierOutcome: 'fast-write-ineligible', model: 'balanced-model' })
    expect(result.result).not.toHaveProperty('usage')
    expect(result.result).not.toHaveProperty('tokenUsage')
    expect(result.cost?.tokenUsage).toBe(0)
  })

  it('isolates ordinary infrastructure failures but propagates token budget exhaustion', async () => {
    const broken = subagents(async () => { throw new Error('transport exploded') })
    const isolated = await fixture({ fake: broken, source: `async function run(wf, args) { return await wf.runAgent({ name: 'optional', prompt: 'try' }); }` })
    const isolatedResult = await (await isolated.engine.start({ module: isolated.module, source: 'inline', parent: isolated.parent })).done
    expect(isolatedResult).toMatchObject({ status: 'completed', result: null, outcome: { status: 'partial' } })

    let release!: () => void
    const gated = new Promise<void>(resolve => { release = resolve })
    const budgetFake = subagents(async (_provider, _request, index) => {
      if (index === 1) await gated
      return { output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }
    })
    const budget = await fixture({ fake: budgetFake, config: { modelTiers: { fast: { subagentProvider: 'spawn', maxTokens: 4 }, balanced: { subagentProvider: 'spawn', maxTokens: 4 }, deep: { subagentProvider: 'spawn', maxTokens: 4 } } }, manifest: { tokenBudget: 6 }, source: `async function run(wf, args) { return await wf.parallel([
      async () => await wf.runAgent({ name: 'one', prompt: 'one' }),
      async () => await wf.runAgent({ name: 'two', prompt: 'two' })
    ], { concurrency: 2 }); }` })
    const budgetRun = await budget.engine.start({ module: budget.module, source: 'inline', parent: budget.parent })
    release()
    const budgetResult = await budgetRun.done
    expect(budgetResult.status).toBe('failed')
    expect(budgetResult.error).toMatch(/token budget exceeded/u)
    expect(budgetFake.starts).toHaveBeenCalledTimes(1)
  })

  it('pauses new admissions, resumes, stops running work, and publishes paired native edges', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const fake = subagents(async (_provider, _request, index) => { if (index === 1) await gate; return { output: [{ type: 'text', text: 'done' }], stopReason: 'completed' } })
    const fx = await fixture({ fake, manifest: { maxConcurrency: 1 }, source: `async function run(wf, args) {
      await wf.runAgent({ name: 'first', prompt: 'wait' });
      return await wf.runAgent({ name: 'second', prompt: 'after pause' });
    }` })
    const run = await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })
    await vi.waitFor(() => expect(fake.starts).toHaveBeenCalledTimes(1))
    expect(fx.engine.pause(run.runId)).toBe(true)
    release()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fake.starts).toHaveBeenCalledTimes(1)
    expect(fx.engine.resume(run.runId)).toBe(true)
    await vi.waitFor(() => expect(fake.starts).toHaveBeenCalledTimes(2))
    expect((await run.done).status).toBe('completed')
    const nativeCalls = (fx.parent.session.append as unknown as ReturnType<typeof vi.fn>).mock.calls
    const nativeTypes = nativeCalls.map(call => call[0])
    expect(nativeTypes).toEqual(['tool-workflow/run-start', 'tool-workflow/agent-start', 'tool-workflow/agent-end', 'tool-workflow/agent-start', 'tool-workflow/agent-end', 'tool-workflow/run-end'])
    expect(nativeCalls[0]?.[1]).toMatchObject({ turn: null })
  })

  it('resumes unchanged task occurrences from the immutable run cache', async () => {
    const fx = await fixture({ source: `async function run(wf, args) { return await wf.runAgent({ name: 'cached', prompt: 'same' }); }` })
    const first = await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })
    expect((await first.done).status).toBe('completed')
    const second = await fx.engine.start({ module: fx.module, source: 'run-snapshot', parent: fx.parent, resumeFromRunId: first.runId })
    const resumed = await second.done
    expect(resumed).toMatchObject({ status: 'completed', resumedFromRunId: first.runId })
    expect(resumed.cost).toMatchObject({ cacheHits: 1, agentsStarted: 0 })
    expect(fx.fake.starts).toHaveBeenCalledTimes(1)
  })

  it('invalidates resume cache when effective read-only policy changes', async () => {
    const fx = await fixture({ source: `async function run(wf, args) { return await wf.runAgent({ name: 'cached-policy', prompt: 'same' }); }` })
    const first = await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })
    expect((await first.done).status).toBe('completed')
    const stricter = new DynamicWorkflowEngine({
      subagents: fx.fake.service,
      config: config({ readOnlyToolFilter: { deny: ['read', 'write', 'shell'] } }),
      store: fx.store,
      resolveNested: async () => { throw new Error('nested workflow not found') },
      id: () => 'run-policy-change',
    })
    const resumed = await stricter.start({ module: fx.module, source: 'run-snapshot', parent: fx.parent, resumeFromRunId: first.runId })
    expect((await resumed.done).cost).toMatchObject({ cacheHits: 0, agentsStarted: 1 })
    expect(fx.fake.starts).toHaveBeenCalledTimes(2)
  })

  it('transfers a released semaphore permit past an aborted admitted waiter', async () => {
    const semaphore = new WorkflowSemaphore(1)
    const holder = await semaphore.acquire(new AbortController().signal)
    const aborted = new AbortController()
    const waiting = semaphore.acquire(aborted.signal)
    const next = semaphore.acquire(new AbortController().signal)
    holder()
    aborted.abort()
    await expect(waiting).rejects.toThrow(/workflow stopped/u)
    const nextLease = await Promise.race([
      next,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('semaphore permit was lost')), 100)),
    ])
    nextLease()
  })

  it('requires each declared changed path to differ from its own pre-task baseline', async () => {
    let request!: SubagentStartRequest
    const events: unknown[] = [
      { type: 'tool/call', data: { callId: 'write-1', name: 'write', arguments: '{"path":"other.txt"}' } },
      { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'write-1', content: [{ type: 'text', text: 'ok' }] }] } } },
    ]
    const localAgent = { session: { events }, followup: vi.fn(async () => {}), whenIdle: vi.fn(async () => {}), cancel: vi.fn(), steer: vi.fn() }
    const starts = vi.fn(async (_provider: string, input: SubagentStartRequest) => {
      request = input
      return {
        id: 'changed-path-child', localAgent,
        result: (async () => {
          await writeFile(join(input.parent.session.header.cwd!, 'other.txt'), 'changed by child')
          return { output: [{ type: 'text' as const, text: 'completed the requested change' }], stopReason: 'completed' as const }
        })(),
        dispose: vi.fn(async () => {}),
      }
    })
    const fake = { starts, service: { getProvider: () => ({ name: 'spawn', capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, inheritsParentContext: false }), start: starts } as unknown as SubagentRuntime }
    const fx = await fixture({ fake, manifest: { readOnly: false }, source: `async function run(wf, args) { return await wf.runAgent({ name: 'writer', prompt: 'change required.txt', verification: { enforcement: 'hard', requiresMutation: true, requiredChangedPaths: ['required.txt'] } }); }` })
    await writeFile(join(fx.cwd, 'required.txt'), 'baseline')
    await writeFile(join(fx.cwd, 'other.txt'), 'baseline')
    await import('node:child_process').then(({ execFileSync }) => {
      execFileSync('git', ['init'], { cwd: fx.cwd })
      execFileSync('git', ['config', 'user.email', 'workflow@example.invalid'], { cwd: fx.cwd })
      execFileSync('git', ['config', 'user.name', 'Workflow Test'], { cwd: fx.cwd })
      execFileSync('git', ['add', '.'], { cwd: fx.cwd })
      execFileSync('git', ['commit', '-m', 'baseline'], { cwd: fx.cwd })
    })
    await writeFile(join(fx.cwd, 'required.txt'), 'already dirty before child')
    const result = await (await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })).done
    expect(request).toBeDefined()
    expect(result).toMatchObject({ status: 'completed', result: null, outcome: { results: [{ status: 'failed', summary: 'completed the requested change' }] } })
    expect(await readFile(join(fx.cwd, 'required.txt'), 'utf8')).toBe('already dirty before child')
  })

  it('enforces one nested level across child run boundaries', async () => {
    const nestedSource = `async function run(wf, args) { return await wf.workflow('too-deep', {}); }`
    const nestedModule = module(nestedSource, { name: 'nested' })
    const fx = await fixture({
      source: `async function run(wf, args) { return await wf.workflow('nested', {}); }`,
      resolveNested: async () => ({ module: nestedModule, source: 'built-in' }),
    })
    const result = await (await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })).done
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/nested workflows are limited to one level/u)
    expect(fx.engine.list()).toHaveLength(1)
  })

  it('runs nested workflows inside the parent resource scope', async () => {
    const nestedModule = module(`async function run(wf, args) { return await wf.runAgent({ name: 'nested-agent', prompt: String(args.prompt) }); }`, { name: 'nested' })
    const fx = await fixture({
      manifest: { maxAgents: 1, maxConcurrency: 1 },
      source: `async function run(wf, args) {
        const nested = await wf.workflow('nested', { prompt: 'nested' });
        const second = await wf.runAgent({ name: 'second', prompt: 'over the shared cap' });
        return { nested, second };
      }`,
      resolveNested: async () => ({ module: nestedModule, source: 'built-in' }),
    })
    const result = await (await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })).done
    expect(result).toMatchObject({ status: 'failed', cost: { agentsStarted: 1 } })
    expect(result.error).toMatch(/agent limit exceeded/u)
    expect(fx.fake.starts).toHaveBeenCalledOnce()
    expect(fx.engine.list()).toHaveLength(1)
  })

  it('fails preflight loudly for unmet environment and capability requirements', async () => {
    const fx = await fixture({ source: 'async function run(wf, args) { return true; }' })
    const capsule = createWorkflowCapsule({
      minDshVersion: '0.0.1-rc.2', manifest: fx.module.manifest, source: fx.module.source!,
      requires: { environment: ['worktree-capable'], tools: ['missing-tool'], mcp: ['missing-mcp'], skills: ['missing-skill'], userInteraction: true },
    })
    const input = { module: { ...fx.module, capsule }, source: 'inline' as const, parent: fx.parent }
    const preflight = await fx.engine.preflight(input)
    expect(preflight.ok).toBe(false)
    expect(preflight.errors.join('\n')).toMatch(/worktree isolation.*missing-tool.*missing-mcp.*missing-skill.*user interaction/su)
    await expect(fx.engine.start(input)).rejects.toThrow(/workflow preflight failed/u)
  })

  it('records approval denial without executing script or child agents', async () => {
    const approval = { request: vi.fn(async () => 'denied' as const) }
    const fx = await fixture({ source: `async function run(wf, args) { return await wf.runAgent({ name: 'never', prompt: 'never' }); }`, config: { approvalMode: 'always' }, approval })
    const result = await (await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })).done
    expect(result.status).toBe('denied')
    expect(approval.request).toHaveBeenCalledOnce()
    expect(fx.fake.starts).not.toHaveBeenCalled()
  })

  it('publishes spawned agents before live messaging and applies isolation, verification, and real usage', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const steer = vi.fn()
    const cancel = vi.fn()
    const dispose = vi.fn(async () => {})
    const child = {
      session: { events: [{ type: 'assistant/message', data: { usage: { inputTokens: 3, outputTokens: 4 } } }] },
      steer, cancel,
    }
    const starts = vi.fn(async (_provider: string, _request: SubagentStartRequest) => ({ id: 'child-live', localAgent: child, result: gate.then(() => ({ output: [{ type: 'text' as const, text: 'verified' }], structured: { ok: true }, stopReason: 'completed' as const })), dispose }))
    const fake = { getProvider: () => ({ name: 'spawn', capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, inheritsParentContext: false }), start: starts } as unknown as SubagentRuntime
    const isolatedParent = parent('C:\\isolated')
    const isolation = { name: 'test', prepare: vi.fn(async () => ({ cwd: 'C:\\isolated', parent: isolatedParent, dispose: vi.fn(async () => {}) })) }
    const verification = { preflight: vi.fn(async () => []), verify: vi.fn(async () => ['warn-only']) }
    const fx = await fixture({
      fake: { service: fake, starts: starts as never }, isolation, verification,
      source: `async function run(wf, args) {
        const handle = await wf.spawnAgent({ name: 'live', phase: 'verify', prompt: 'inspect', scopeSummary: 'src', constraints: ['no edits'], evidenceRefs: ['finding:1'], isolation: 'worktree', verification: { enforcement: 'warn' }, outputSchema: { type: 'object', additionalProperties: true }, terseResult: true });
        await wf.send(handle.taskId, 'focus');
        const before = await wf.snapshot(handle.taskId);
        const output = await wf.output(handle.taskId);
        const result = await wf.wait(handle.taskId, { timeoutMs: 1000 });
        return { before: before.status, output: output.status, result };
      }`,
    })
    const active = await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })
    await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce())
    release()
    const completed = await active.done
    expect(completed).toMatchObject({ status: 'completed', cost: { tokenUsage: 7 } })
    expect(completed.result).toMatchObject({ before: 'running', output: 'running', result: { verificationWarnings: ['warn-only'], structured: { ok: true } } })
    expect(isolation.prepare).toHaveBeenCalledOnce()
    expect(verification.preflight).toHaveBeenCalledOnce()
    expect(verification.verify).toHaveBeenCalledOnce()
    expect(starts.mock.calls[0]?.[1].prompt[0]).toMatchObject({ text: expect.stringMatching(/Scope: src.*Constraints:.*Evidence references:.*Isolated workspace: C:\\isolated.*terse final result/su) })
    expect(cancel).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('enforces verification preflight and exposes warn-only completion explicitly', async () => {
    const hardAdapter: WorkflowVerificationAdapter = { preflight: async () => ['missing baseline'], verify: async () => [] }
    const hard = await fixture({ verification: hardAdapter, source: `async function run(wf, args) { return await wf.runAgent({ name: 'checked', prompt: 'inspect', verification: { enforcement: 'hard' } }); }` })
    const hardResult = await (await hard.engine.start({ module: hard.module, source: 'inline', parent: hard.parent })).done
    expect(hardResult).toMatchObject({ status: 'failed', outcome: { results: [{ status: 'failed' }] } })
    expect(hard.fake.starts).not.toHaveBeenCalled()

    const warnAdapter: WorkflowVerificationAdapter = { preflight: async () => ['baseline warning'], verify: async () => [] }
    const warn = await fixture({ verification: warnAdapter, source: `async function run(wf, args) { return await wf.runAgent({ name: 'checked', prompt: 'inspect', verification: { enforcement: 'warn' } }); }` })
    const warnResult = await (await warn.engine.start({ module: warn.module, source: 'inline', parent: warn.parent })).done
    expect(warnResult.result).toMatchObject({ status: 'completed_unverified', verification: { ok: false, reasons: ['baseline warning'] } })
    expect(warnResult.outcome).toMatchObject({ status: 'completed', coverage: ['checked'] })
  })

  it('repairs a hard read contract on the same local actor and captures the evidence', async () => {
    const calls: unknown[] = []
    const starts = vi.fn(async (_provider: string, request: SubagentStartRequest) => {
      const events: unknown[] = []
      const localAgent = {
        session: { events },
        followup: vi.fn(() => {
          events.push(
            { type: 'tool/call', data: { callId: 'call-1', name: 'read', arguments: '{"path":"evidence.txt"}' } },
            { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] }] } } },
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'repaired final result' }] } } },
          )
          calls.push('followup')
        }),
        whenIdle: vi.fn(async () => {}), cancel: vi.fn(), steer: vi.fn(),
      }
      return { id: 'local-child', localAgent, result: Promise.resolve({ output: [{ type: 'text' as const, text: 'initial' }], stopReason: 'completed' as const }), dispose: vi.fn(async () => {}) }
    })
    const fake: FakeSubagents = {
      starts,
      service: { getProvider: (name: string) => ({ name, capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, inheritsParentContext: false }), start: starts } as unknown as SubagentRuntime,
    }
    const fx = await fixture({ fake, source: `async function run(wf, args) { return await wf.runAgent({ name: 'reader', prompt: 'read it', verification: { enforcement: 'hard', requiredReadPaths: ['evidence.txt'] } }); }` })
    await writeFile(join(fx.cwd, 'evidence.txt'), 'evidence')
    const result = await (await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })).done
    expect(calls).toEqual(['followup'])
    expect(result.result).toMatchObject({ status: 'completed', finalText: 'repaired final result', verification: { ok: true, readPaths: ['evidence.txt'] } })
  })

  it('marks unprovable write completion and hard text failure without inventing evidence', async () => {
    const implicit = await fixture({ manifest: { readOnly: false }, source: `async function run(wf, args) { return await wf.runAgent({ name: 'writer', prompt: 'change it' }); }` })
    const implicitResult = await (await implicit.engine.start({ module: implicit.module, source: 'inline', parent: implicit.parent })).done
    expect(implicitResult.result).toMatchObject({ status: 'completed_unverified', verification: { ok: false, mutationEvidence: false } })

    const hard = await fixture({ source: `async function run(wf, args) { return await wf.runAgent({ name: 'short', prompt: 'answer', verification: { enforcement: 'hard', minFinalTextChars: 100 } }); }` })
    const hardResult = await (await hard.engine.start({ module: hard.module, source: 'inline', parent: hard.parent })).done
    expect(hardResult).toMatchObject({ status: 'completed', result: null, outcome: { status: 'partial' } })
    expect(hardResult.outcome?.results[0]).toMatchObject({ status: 'failed', summary: 'result-1', artifacts: [] })
  })

  it('keeps a failed run failed even after covered child work', async () => {
    const fx = await fixture({ source: `async function run(wf, args) { await wf.runAgent({ name: 'covered', prompt: 'finish' }); throw new Error('parent protocol failed'); }` })
    const result = await (await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })).done
    expect(result).toMatchObject({ status: 'failed', outcome: { status: 'failed', coverage: ['covered'], errors: [{ message: expect.stringContaining('parent protocol failed') }] } })
  })

  it('preserves hard-verification final text, measured usage, and route facts on failure', async () => {
    const events: unknown[] = [{ type: 'assistant/message', data: { usage: { inputTokens: 5, outputTokens: 7 }, message: { content: [{ type: 'text', text: 'initial complete answer' }] } } }]
    const localAgent = {
      session: { events },
      followup: vi.fn(() => { events.push({ type: 'assistant/message', data: { usage: { inputTokens: 1, outputTokens: 2 }, message: { content: [{ type: 'text', text: 'repaired but still rejected' }] } } }) }),
      whenIdle: vi.fn(async () => {}), cancel: vi.fn(), steer: vi.fn(),
    }
    const starts = vi.fn(async () => ({ id: 'verified-child', localAgent, result: Promise.resolve({ output: [{ type: 'text' as const, text: 'initial complete answer' }], stopReason: 'completed' as const }), dispose: vi.fn(async () => {}) }))
    const fake: FakeSubagents = { starts, service: { getProvider: (name: string) => ({ name, capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, inheritsParentContext: false }), start: starts } as unknown as SubagentRuntime }
    const verification: WorkflowVerificationAdapter = { preflight: async () => [], verify: async () => ['proof rejected'] }
    const fx = await fixture({ fake, verification, source: `async function run(wf, args) { const handle = await wf.spawnAgent({ name: 'strict', prompt: 'answer', modelHint: 'deep', verification: { enforcement: 'hard' } }); return await wf.wait(handle.taskId); }` })
    const result = await (await fx.engine.start({ module: fx.module, source: 'inline', parent: fx.parent })).done
    expect(result.result).toMatchObject({ status: 'failed', finalText: 'repaired but still rejected', usage: { totalTokens: 18 }, provider: 'mock-llm', model: 'deep-model', requestedTier: 'deep', tierOutcome: 'applied' })
    expect(result.outcome?.results[0]).toMatchObject({ status: 'failed', summary: 'repaired but still rejected', usage: { totalTokens: 18 } })
    expect(result.cost?.tokenUsage).toBe(18)
    const stored = fx.store.get(result.runId)
    expect(stored?.outcome?.results[0]).toMatchObject({ summary: 'repaired but still rejected' })
  })

  it('shares deployment concurrency across independent workflow runs', async () => {
    const gate = new WorkflowSemaphore(1)
    let active = 0
    let peak = 0
    const controlled = subagents(async (_provider, _request, index) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, index === 1 ? 30 : 5))
      active -= 1
      return { output: [{ type: 'text', text: `done-${index}` }], stopReason: 'completed' }
    })
    const first = await fixture({ fake: controlled, deploymentSemaphore: gate, source: `async function run(wf, args) { return await wf.runAgent({ name: 'one', prompt: 'one' }); }` })
    const second = await fixture({ fake: controlled, deploymentSemaphore: gate, source: `async function run(wf, args) { return await wf.runAgent({ name: 'two', prompt: 'two' }); }` })
    const runOne = await first.engine.start({ module: first.module, source: 'inline', parent: first.parent })
    const runTwo = await second.engine.start({ module: second.module, source: 'inline', parent: second.parent })
    await Promise.all([runOne.done, runTwo.done])
    expect(peak).toBe(1)
  })

  it('supports bounded waits and whole-run cancellation', async () => {
    const timeoutFake = subagents(async (_provider, request) => await new Promise(resolve => {
      setTimeout(() => resolve({ output: [{ type: 'text', text: 'late' }], stopReason: 'completed' }), request.label === 'slow' ? 20 : 0)
    }))
    const timeout = await fixture({ fake: timeoutFake, source: `async function run(wf, args) {
      const handle = await wf.spawnAgent({ name: 'slow', prompt: 'slow' });
      try { await wf.wait(handle.taskId, { timeoutMs: 1 }); } catch (error) { wf.log('wait timed out'); }
      return await wf.wait(handle.taskId);
    }` })
    expect(await (await timeout.engine.start({ module: timeout.module, source: 'inline', parent: timeout.parent })).done).toMatchObject({ status: 'completed' })

    let settle!: (value: { output: { type: 'text'; text: string }[]; stopReason: 'aborted' }) => void
    const pending = new Promise<{ output: { type: 'text'; text: string }[]; stopReason: 'aborted' }>(resolve => { settle = resolve })
    const cancel = vi.fn(() => settle({ output: [{ type: 'text', text: 'cancelled' }], stopReason: 'aborted' }))
    const starts = vi.fn(async () => ({ id: 'child-cancel', localAgent: { session: { events: [] }, cancel, steer: vi.fn() }, result: pending, dispose: vi.fn(async () => {}) }))
    const service = { getProvider: () => ({ name: 'spawn', capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, inheritsParentContext: false }), start: starts } as unknown as SubagentRuntime
    const stopped = await fixture({ fake: { service, starts: starts as never }, source: `async function run(wf, args) { return await wf.runAgent({ name: 'cancel', prompt: 'cancel' }); }` })
    const active = await stopped.engine.start({ module: stopped.module, source: 'inline', parent: stopped.parent })
    await vi.waitFor(() => expect(starts).toHaveBeenCalledOnce())
    expect(stopped.engine.stop(active.runId, 'user stop')).toBe(true)
    expect((await active.done)).toMatchObject({ status: 'stopped', error: expect.stringContaining('user stop') })
    expect(cancel).toHaveBeenCalledOnce()
    expect(stopped.engine.stop(active.runId)).toBe(false)
  })
})
