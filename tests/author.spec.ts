import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import { authorWorkflowCapsule } from '../src/author.js'
import type { ResolvedWorkflowConfig } from '../src/types.js'

const parent = { session: { header: { cwd: 'C:\\workspace' } }, ctx: { tools: { schemas: () => [{ name: 'read' }, { name: 'write' }, { name: 'shell' }] } } } as unknown as Agent

function config(): ResolvedWorkflowConfig {
  return {
    projectDirectory: '.dsh/workflows', personalDirectory: 'workflows', runDirectory: '.dsh/workflow-runs',
    maxCapsuleBytes: 10_000, maxCatalogEntries: 20, maxAgents: 8, maxConcurrency: 4,
    maxResultChars: 10_000, scriptSyncTimeoutMs: 100, scriptWallTimeoutMs: 1_000,
    defaultProvider: 'spawn', synthesisProvider: 'spawn',
    modelTiers: { fast: { subagentProvider: 'scout', provider: 'fast-llm', model: 'quick', maxTokens: 100 }, balanced: { subagentProvider: 'spawn', maxTokens: 200 }, deep: { subagentProvider: 'author', provider: 'deep-llm', model: 'deep', maxTokens: 300 } },
    readOnlyToolFilter: { deny: ['write', 'shell'] }, approvalMode: 'never', availableTools: [], availableMcp: [], availableSkills: [],
    maxRetainedRuns: 20, pluginVersion: '0.1.0', dshVersion: '0.0.1-rc.2',
  }
}

function authored(source = `async function run(wf, args) { return await wf.runAgent({ name: 'worker', prompt: String(args.request), readOnly: true }); }`) {
  return {
    manifest: { name: 'authored', description: 'An authored workflow.', phases: ['run'], readOnly: true, plannedAgents: 1, maxAgents: 2, maxConcurrency: 1, patterns: ['classify-and-act'], inputSchema: { type: 'object', additionalProperties: true } },
    source,
    intent: { taskClass: 'implementation', originalRequest: 'build it' },
    inputs: { description: 'A request object.' },
    requires: { tools: [] },
  }
}

function service(payloads: unknown[], capabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }) {
  let index = 0
  const start = vi.fn(async (_provider: string, _request: SubagentStartRequest) => {
    const payload = payloads[index++]
    return {
      id: `child-${index}`, localAgent: undefined,
      result: Promise.resolve(index === 1
        ? { output: [{ type: 'text' as const, text: 'workspace facts' }], stopReason: 'completed' as const }
        : { output: [{ type: 'text' as const, text: 'authored' }], structured: payload, stopReason: 'completed' as const }),
      dispose: vi.fn(async () => {}),
    }
  })
  return {
    start,
    value: { getProvider: (name: string) => ['scout', 'author'].includes(name) ? { name, capabilities, inheritsParentContext: false } : undefined, start } as unknown as SubagentRuntime,
  }
}

describe('scout-then-author workflow generation', () => {
  it('uses read-only model-tier routes and returns a validated capsule', async () => {
    const fake = service([undefined, authored()])
    const result = await authorWorkflowCapsule({ request: 'build it', parent, subagents: fake.value, config: config(), signal: new AbortController().signal })
    expect(result.capsule).toMatchObject({ format: 'dsh.workflow', manifest: { name: 'authored' }, provenance: { dshVersion: '0.0.1-rc.2', pluginVersion: '0.1.0' } })
    expect(fake.start).toHaveBeenCalledTimes(2)
    expect(fake.start.mock.calls[0]).toMatchObject(['scout', { toolFilter: { allow: ['read'] }, agentOptions: { provider: 'fast-llm', model: 'quick', maxTokens: 100 } }])
    expect(fake.start.mock.calls[1]).toMatchObject(['author', { outputSchema: expect.any(Object), agentOptions: { provider: 'deep-llm', model: 'deep', maxTokens: 300 } }])
  })

  it('feeds validation failures into a bounded repair loop', async () => {
    const fake = service([undefined, authored('not a workflow'), authored()])
    const result = await authorWorkflowCapsule({ request: 'build it', parent, subagents: fake.value, config: config(), signal: new AbortController().signal })
    expect(result.capsule.manifest.name).toBe('authored')
    expect(fake.start).toHaveBeenCalledTimes(3)
    expect(fake.start.mock.calls[2]?.[1].prompt[0]).toMatchObject({ text: expect.stringContaining('Repair this validation failure') })
  })

  it('fails loudly when authoring cannot enforce required provider capabilities', async () => {
    const fake = service([], { outputSchema: true, depthLimit: true, toolFilter: false, persona: true })
    await expect(authorWorkflowCapsule({ request: 'build it', parent, subagents: fake.value, config: config(), signal: new AbortController().signal })).rejects.toThrow(/cannot enforce read-only/u)
    await expect(authorWorkflowCapsule({ request: ' ', parent, subagents: fake.value, config: config(), signal: new AbortController().signal })).rejects.toThrow(/must be non-empty/u)
  })

  it('bounds irreparable author output and validates structured-output capability', async () => {
    const invalid = service([undefined, authored('invalid'), authored('invalid'), authored('invalid')])
    await expect(authorWorkflowCapsule({ request: 'build it', parent, subagents: invalid.value, config: config(), signal: new AbortController().signal })).rejects.toThrow(/failed validation after 3 attempts/u)
    expect(invalid.start).toHaveBeenCalledTimes(4)

    const incapable = service([undefined], { outputSchema: false, depthLimit: true, toolFilter: true, persona: true })
    await expect(authorWorkflowCapsule({ request: 'build it', parent, subagents: incapable.value, config: config(), signal: new AbortController().signal })).rejects.toThrow(/cannot produce structured output/u)
  })

  it('records revision and source-run provenance', async () => {
    const firstFake = service([undefined, authored()])
    const first = await authorWorkflowCapsule({ request: 'build it', parent, subagents: firstFake.value, config: config(), signal: new AbortController().signal })
    const revisedFake = service([undefined, authored()])
    const revised = await authorWorkflowCapsule({ request: 'build it', parent, subagents: revisedFake.value, config: config(), signal: new AbortController().signal, existing: first.capsule, change: 'more evidence', fromRunId: 'run-source' })
    expect(revised.capsule.provenance).toMatchObject({ fromRunId: 'run-source', fromWorkflowName: 'authored', revisionOf: 'authored' })
    expect(revisedFake.start.mock.calls[1]?.[1].prompt[0]).toMatchObject({ text: expect.stringMatching(/Existing capsule:.*Requested change:\nmore evidence/su) })
  })

  it('rejects an agent name passed where an opaque task id is required', async () => {
    const source = `async function run(wf, args) {
      await wf.spawnAgent({ name: 'worker', prompt: String(args.request), readOnly: true });
      return await wf.wait('worker');
    }`
    const fake = service([undefined, authored(source), authored(source), authored(source)])
    await expect(authorWorkflowCapsule({ request: 'build it', parent, subagents: fake.value, config: config(), signal: new AbortController().signal })).rejects.toThrow(/used an agent name.*taskId/su)
  })

  it('accepts task APIs called with the handle returned by spawnAgent', async () => {
    const source = `async function run(wf, args) {
      const handle = await wf.spawnAgent({ name: 'worker', prompt: String(args.request), readOnly: true });
      await wf.send(handle.taskId, 'focus on evidence');
      const snapshot = await wf.snapshot(handle.taskId);
      const output = await wf.output(handle.taskId);
      const result = await wf.wait(handle.taskId);
      await wf.stop(handle.taskId, 'smoke complete');
      return { summary: result.finalText, taskId: snapshot.taskId, outputTaskId: output.taskId };
    }`
    const fake = service([undefined, authored(source)])
    const result = await authorWorkflowCapsule({ request: 'build it', parent, subagents: fake.value, config: config(), signal: new AbortController().signal })
    expect(result.capsule.source).toBe(source)
  })

  it('rejects an agent name or unknown task id in evidenceRefs during smoke validation', async () => {
    for (const reference of ['task_id:first', 'task_id:unknown-task-id']) {
      const source = `async function run(wf, args) {
        const first = await wf.spawnAgent({ name: 'first', prompt: 'inspect', readOnly: true });
        const second = await wf.runAgent({ name: 'second', prompt: 'verify', readOnly: true, evidenceRefs: ['${reference}'] });
        await wf.wait(first.taskId);
        return second;
      }`
      const fake = service([undefined, authored(source), authored(source), authored(source)])
      await expect(authorWorkflowCapsule({ request: 'build it', parent, subagents: fake.value, config: config(), signal: new AbortController().signal })).rejects.toThrow(reference === 'task_id:first' ? /used an agent name.*taskId/su : /unknown workflow task id/u)
    }
  })

  it('accepts evidenceRefs that use a previously returned smoke task id', async () => {
    const source = `async function run(wf, args) {
      const first = await wf.spawnAgent({ name: 'first', prompt: 'inspect', readOnly: true });
      const second = await wf.runAgent({ name: 'second', prompt: 'verify', readOnly: true, evidenceRefs: ['task_id:' + first.taskId] });
      await wf.wait(first.taskId);
      return { summary: second && second.finalText };
    }`
    const fake = service([undefined, authored(source)])
    await expect(authorWorkflowCapsule({ request: 'build it', parent, subagents: fake.value, config: config(), signal: new AbortController().signal })).resolves.toMatchObject({ capsule: { source } })
  })

  it.each([
    ['wait', "await wf.wait('unknown-task-id')"],
    ['snapshot', "await wf.snapshot('unknown-task-id')"],
    ['output', "await wf.output('unknown-task-id')"],
    ['send', "await wf.send('unknown-task-id', 'focus')"],
    ['stop', "await wf.stop('unknown-task-id', 'cancel')"],
  ])('rejects an unknown task id passed to wf.%s', async (_method, command) => {
    const source = `async function run(wf, args) {
      const handle = await wf.spawnAgent({ name: 'worker', prompt: String(args.request), readOnly: true });
      ${command};
      await wf.wait(handle.taskId);
      return { summary: 'done' };
    }`
    const fake = service([undefined, authored(source), authored(source), authored(source)])
    await expect(authorWorkflowCapsule({ request: 'build it', parent, subagents: fake.value, config: config(), signal: new AbortController().signal })).rejects.toThrow(/unknown workflow task id/u)
  })

  it('rejects an empty agent name during smoke validation', async () => {
    const source = `async function run(wf, args) {
      const result = await wf.runAgent({ name: '', prompt: String(args.request), readOnly: true });
      return { summary: result && result.finalText };
    }`
    const fake = service([undefined, authored(source), authored(source), authored(source)])
    await expect(authorWorkflowCapsule({ request: 'build it', parent, subagents: fake.value, config: config(), signal: new AbortController().signal })).rejects.toThrow(/workflow agent input\.name must be a non-empty string/u)
  })

  it.each([
    ['null', 'null'],
    ['an empty string', "''"],
    ['an empty object', '{}'],
    ['an empty array', '[]'],
    ['empty display fields', "{ summary: '', text: '' }"],
  ])('rejects %s as a non-displayable top-level result when no artifact was written', async (_label, returned) => {
    const source = `async function run(wf, args) {
      await wf.runAgent({ name: 'worker', prompt: String(args.request), readOnly: true });
      return ${returned};
    }`
    const fake = service([undefined, authored(source), authored(source), authored(source)])
    await expect(authorWorkflowCapsule({ request: 'build it', parent, subagents: fake.value, config: config(), signal: new AbortController().signal })).rejects.toThrow(/no displayable result or artifact/u)
  })

  it('accepts an otherwise empty top-level result when the workflow wrote an artifact', async () => {
    const source = `async function run(wf, args) {
      await wf.runAgent({ name: 'worker', prompt: String(args.request), readOnly: true });
      await wf.artifact('report', { status: 'done' });
      return null;
    }`
    const fake = service([undefined, authored(source)])
    const result = await authorWorkflowCapsule({ request: 'build it', parent, subagents: fake.value, config: config(), signal: new AbortController().signal })
    expect(result.capsule.source).toBe(source)
  })
})
