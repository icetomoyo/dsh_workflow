import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import workflowPlugin, { apply, name, type Config } from '../src/index.js'
import type { WorkflowRun, WorkflowRunSnapshot } from '../src/types.js'

const execFileAsync = promisify(execFile)

function snapshot(overrides: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    runId: 'run-1', workflow: 'demo', displayName: 'demo', status: 'completed', source: 'inline', execution: 'capability-generated',
    startedAt: 1, endedAt: 2, totalSpawned: 0, activeAgents: 0, eventCount: 1, artifacts: [], result: 'ok', resultSummary: 'ok', ...overrides,
  }
}

function run(overrides: Partial<WorkflowRunSnapshot> = {}): WorkflowRun {
  const value = snapshot(overrides)
  return { runId: value.runId, done: Promise.resolve(value), getSnapshot: () => value }
}

function fixture(pluginConfig: Config = { approvalMode: 'never', maxAgents: 7, maxConcurrency: 3 }, withOptionalServices = false) {
  const tools: unknown[] = []
  let command: { handler(input: unknown): Promise<unknown> } | undefined
  const sections: unknown[] = []
  const service = {
    list: vi.fn(async () => ({ entries: [{ name: 'known', valid: true }], diagnostics: [] })),
    startNamed: vi.fn(async () => run()), startInline: vi.fn(async () => run()),
    create: vi.fn(async () => ({ capsule: { manifest: { name: 'created', description: 'created', phases: ['run'], readOnly: true, maxAgents: 1, maxConcurrency: 1, patterns: ['classify-and-act'] }, source: 'async function run(wf, args) { return true; }' }, warnings: [] })),
    rerun: vi.fn(async () => run({ source: 'run-snapshot' })), attachBackgroundJob: vi.fn(() => 'workflow-1'),
    runs: vi.fn(() => [snapshot()]), show: vi.fn(() => snapshot()), events: vi.fn(() => []), pause: vi.fn(() => true), resume: vi.fn(() => true), stop: vi.fn(() => true),
    saveRun: vi.fn(async () => 'saved'), renameRun: vi.fn(() => snapshot({ displayName: 'renamed' })), renameSaved: vi.fn(async () => 'renamed'),
    revise: vi.fn(async () => ({ capsule: { manifest: { name: 'revised' } }, warnings: [], path: 'revised' })),
    deleteRun: vi.fn(), deleteSaved: vi.fn(async () => {}), prune: vi.fn(() => ({ candidates: [], deleted: [] })), confirm: vi.fn(async () => true),
  }
  const ctx = {
    get: vi.fn((key: string) => withOptionalServices ? { service: key } : undefined), subagents: {}, dynamicWorkflows: service,
    plugin: vi.fn(),
    tools: { register: vi.fn(value => { tools.push(value) }) },
    inject: vi.fn((dependencies: string[], callback: (child: unknown) => void) => {
      if (dependencies.includes('dynamicWorkflows')) callback(ctx)
      if (dependencies.includes('systemPrompt')) callback({ systemPrompt: { section: (value: unknown) => sections.push(value) } })
      if (dependencies.includes('commands')) callback({ commands: { register: (value: typeof command) => { command = value } } })
    }),
  }
  apply(ctx as never, pluginConfig)
  return { ctx, tools: tools as Array<{ name: string; output: { render(args: unknown, value: unknown): unknown }; execute(args: Record<string, unknown>, exec: unknown): Promise<unknown> }>, command: () => command!, sections, service }
}

const agent = { session: { header: { cwd: 'C:\\workspace' } }, steer: vi.fn() } as unknown as Agent
const exec = { agent, signal: new AbortController().signal }

describe('Cordis plugin entrypoint', () => {
  it('publishes its service before installing dependent surfaces in a real Cordis context', async () => {
    const registered: unknown[] = []
    class StubSubagents extends Service {
      constructor(ctx: Context) { super(ctx, 'subagents') }
    }
    class StubTools extends Service {
      constructor(ctx: Context) { super(ctx, 'tools') }
      register(value: unknown): () => void { registered.push(value); return () => {} }
    }
    const ctx = new Context()
    const subagents = await ctx.plugin(StubSubagents)
    const tools = await ctx.plugin(StubTools)
    const workflow = await ctx.plugin(workflowPlugin, { approvalMode: 'never' })
    expect(ctx.dynamicWorkflows).toBeDefined()
    expect(registered).toHaveLength(3)
    await workflow.dispose()
    await tools.dispose()
    await subagents.dispose()
  })

  it('aborts and awaits active workflow children when the Cordis plugin unloads', async () => {
    const childDisposed = vi.fn(async () => {})
    class StubSubagents extends Service {
      constructor(ctx: Context) { super(ctx, 'subagents') }
      getProvider(name: string) { return { name, capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }, inheritsParentContext: false } }
      async start(_provider: string, request: { readonly signal: AbortSignal }) {
        const result = new Promise<{ output: []; stopReason: 'aborted' }>(resolve => {
          request.signal.addEventListener('abort', () => resolve({ output: [], stopReason: 'aborted' }), { once: true })
        })
        return { id: 'active-child', localAgent: undefined, result, dispose: childDisposed }
      }
    }
    class StubTools extends Service {
      constructor(ctx: Context) { super(ctx, 'tools') }
      register(): () => void { return () => {} }
      schemas(): unknown[] { return [{ name: 'read' }] }
    }
    const ctx = new Context()
    const subagents = await ctx.plugin(StubSubagents)
    const tools = await ctx.plugin(StubTools)
    const workflow = await ctx.plugin(workflowPlugin, { approvalMode: 'never' })
    const liveAgent = { id: 'parent', ctx, session: { id: 'parent', header: { cwd: 'C:\\workspace' }, events: [], append: vi.fn() } } as unknown as Agent
    const active = await ctx.dynamicWorkflows.startInline(liveAgent, {
      manifest: { name: 'active', description: 'active', phases: ['run'], readOnly: true, maxAgents: 1, maxConcurrency: 1, patterns: ['classify-and-act'] },
      execution: 'trusted-package', run: async wf => await wf.runAgent({ name: 'slow', prompt: 'wait', readOnly: true }),
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    await workflow.dispose()
    expect(await active.done).toMatchObject({ status: 'stopped' })
    expect(childDisposed).toHaveBeenCalled()
    await tools.dispose()
    await subagents.dispose()
  })

  it('registers the service, three tools, system guidance, and /workflow command', () => {
    const fx = fixture()
    expect(name).toBe('dsh-external-workflow')
    expect(fx.ctx.plugin).toHaveBeenCalledOnce()
    expect(fx.tools.map(tool => tool.name)).toEqual(['workflow_list', 'run_workflow', 'workflow_manage'])
    expect(fx.sections).toEqual([expect.objectContaining({
      name: 'tool:dynamic-workflows',
      text: expect.stringMatching(/workflow relay[\s\S]*source \+ manifest[\s\S]*do not use request mode/u),
    })])
    expect(fx.command()).toBeDefined()
  })

  it('resolves every explicit deployment option and optional DSH service', async () => {
    const fx = fixture({
      projectDirectory: 'project', personalDirectory: 'personal', runDirectory: 'runs', listToolName: 'flows', runToolName: 'execute_flow', manageToolName: 'manage_flow',
      maxCapsuleBytes: 10, maxCatalogEntries: 11, maxAgents: 12, maxConcurrency: 2, maxResultChars: 13, scriptSyncTimeoutMs: 14, scriptWallTimeoutMs: 15,
      defaultProvider: 'default', synthesisProvider: 'synthesis', fastProvider: 'fast-p', fastModelProvider: 'fast-llm', fastModel: 'fast-m', fastMaxTokens: 16,
      balancedProvider: 'balanced-p', balancedModelProvider: 'balanced-llm', balancedModel: 'balanced-m', balancedMaxTokens: 17, deepProvider: 'deep-p', deepModelProvider: 'deep-llm', deepModel: 'deep-m', deepMaxTokens: 18,
      readOnlyDeniedTools: ['danger'], approvalMode: 'always', availableTools: ['read'], availableMcp: ['docs'], availableSkills: ['review'], maxRetainedRuns: 19,
    }, true)
    expect(fx.tools.map(tool => tool.name)).toEqual(['flows', 'execute_flow', 'manage_flow'])
    const options = fx.ctx.plugin.mock.calls[0]?.[1] as Record<string, unknown>
    expect(options).toMatchObject({ config: { projectDirectory: 'project', modelTiers: { fast: { subagentProvider: 'fast-p', provider: 'fast-llm', model: 'fast-m', maxTokens: 16 } }, readOnlyToolFilter: { deny: ['danger'] } }, approval: { service: 'approval' }, jobs: { service: 'jobs' }, userQuestions: { service: 'userQuestions' } })
    expect(fx.tools[0]!.output.render({}, { ok: true })).toEqual([{ type: 'text', text: '{\n  "ok": true\n}' }])
    await expect(fx.tools[0]!.execute({}, { signal: exec.signal })).rejects.toThrow(/requires a calling DSH agent/u)
    ;(fx.service.attachBackgroundJob as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined)
    expect(await fx.tools[1]!.execute({ name: 'known', background: true }, exec)).toMatchObject({ runId: 'run-1', status: 'completed' })
  })

  it('executes named, authored, inline, and background workflow tool modes', async () => {
    const fx = fixture()
    const list = fx.tools.find(tool => tool.name === 'workflow_list')!
    const execute = fx.tools.find(tool => tool.name === 'run_workflow')!
    expect(await list.execute({}, exec)).toMatchObject({ entries: [{ name: 'known' }] })
    expect(await execute.execute({ name: 'known', args: { value: 1 } }, exec)).toMatchObject({ status: 'completed' })
    expect(await execute.execute({ request: 'create one', args: {}, save_scope: 'project', background: true }, exec)).toMatchObject({ runId: 'run-1', jobId: 'workflow-1' })
    expect(await execute.execute({ source: 'async function run(wf, args) { return args; }', manifest: { name: 'inline', description: 'inline', phases: ['run'], readOnly: true, maxAgents: 1, maxConcurrency: 1, patterns: ['classify-and-act'] }, args: {} }, exec)).toMatchObject({ status: 'completed' })
    await expect(execute.execute({ name: 'a', request: 'b' }, exec)).rejects.toThrow(/exactly one/u)
    await expect(execute.execute({ source: 'async function run(wf, args) {}' }, exec)).rejects.toThrow(/requires manifest/u)
    expect(fx.service.startNamed).toHaveBeenCalledOnce()
    expect(fx.service.create).toHaveBeenCalledWith(agent, 'create one', exec.signal, { scope: 'project' })
  })

  it('grants exactly one inline run to the exact /workflow handoff message', async () => {
    const fx = fixture({ approvalMode: 'generated-and-local' })
    fx.service.list.mockResolvedValueOnce({ entries: [], diagnostics: [] })
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    const steer = vi.fn()
    const explicitAgent = { session: { header: { cwd: 'C:\\workspace' }, events }, steer } as unknown as Agent
    const execute = fx.tools.find(tool => tool.name === 'run_workflow')!
    expect(await fx.command().handler({ agent: explicitAgent, rawInput: 'inspect then coordinate', signal: exec.signal }))
      .toMatchObject({ kind: 'success' })
    const handoff = steer.mock.calls[0]![0] as { readonly id: string; readonly source: Record<string, unknown> }
    events.push({ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: handoff })
    const inline = {
      source: 'async function run(wf, args) { return args; }',
      manifest: { name: 'inline', description: 'inline', phases: ['run'], readOnly: true, maxAgents: 1, maxConcurrency: 1, patterns: ['classify-and-act'] },
      args: {},
    }

    await execute.execute(inline, { agent: explicitAgent, signal: exec.signal })
    await execute.execute(inline, { agent: explicitAgent, signal: exec.signal })

    expect(fx.service.startInline.mock.calls.at(-2)).toEqual([explicitAgent, expect.anything(), {}, exec.signal, 'inline', true])
    expect(fx.service.startInline.mock.calls.at(-1)).toEqual([explicitAgent, expect.anything(), {}, exec.signal, 'inline', false])
  })

  it('does not consume the handoff grant when inline validation fails', async () => {
    const fx = fixture({ approvalMode: 'generated-and-local' })
    fx.service.list.mockResolvedValueOnce({ entries: [], diagnostics: [] })
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    const steer = vi.fn()
    const explicitAgent = { session: { header: { cwd: 'C:\\workspace' }, events }, steer } as unknown as Agent
    const execute = fx.tools.find(tool => tool.name === 'run_workflow')!
    await fx.command().handler({ agent: explicitAgent, rawInput: 'author then correct if needed', signal: exec.signal })
    events.push({ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: steer.mock.calls[0]![0] })

    await expect(execute.execute({
      source: 'async function run(wf, args) { return args; }',
      manifest: { name: '', description: 'invalid empty name', phases: ['run'], readOnly: true, maxAgents: 1, maxConcurrency: 1, patterns: ['classify-and-act'] },
    }, { agent: explicitAgent, signal: exec.signal })).rejects.toThrow()
    expect(fx.service.startInline).not.toHaveBeenCalled()

    await execute.execute({
      source: 'async function run(wf, args) { return args; }',
      manifest: { name: 'corrected', description: 'corrected', phases: ['run'], readOnly: true, maxAgents: 1, maxConcurrency: 1, patterns: ['classify-and-act'] },
      args: {},
    }, { agent: explicitAgent, signal: exec.signal })
    expect(fx.service.startInline).toHaveBeenLastCalledWith(explicitAgent, expect.anything(), {}, exec.signal, 'inline', true)
  })

  it('rejects forged, stale, superseded, and request-mode command handoffs', async () => {
    const inline = {
      source: 'async function run(wf, args) { return args; }',
      manifest: { name: 'inline', description: 'inline', phases: ['run'], readOnly: true, maxAgents: 1, maxConcurrency: 1, patterns: ['classify-and-act'] },
      args: {},
    }
    const forged = fixture({ approvalMode: 'generated-and-local' })
    const forgedAgent = { session: { header: { cwd: 'C:\\workspace' }, events: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { id: 'forged', source: { kind: 'plugin', plugin: '@dsh-external/workflow', form: 'relay' } } },
    ] } } as unknown as Agent
    await forged.tools.find(tool => tool.name === 'run_workflow')!.execute(inline, { agent: forgedAgent, signal: exec.signal })
    expect(forged.service.startInline).toHaveBeenLastCalledWith(forgedAgent, expect.anything(), {}, exec.signal, 'inline', false)

    for (const suffix of ['stale', 'superseded'] as const) {
      const fx = fixture({ approvalMode: 'generated-and-local' })
      fx.service.list.mockResolvedValueOnce({ entries: [], diagnostics: [] })
      const events: Array<{ type: string; data: Record<string, unknown> }> = []
      const steer = vi.fn()
      const liveAgent = { session: { header: { cwd: 'C:\\workspace' }, events }, steer } as unknown as Agent
      await fx.command().handler({ agent: liveAgent, rawInput: `coordinate ${suffix}`, signal: exec.signal })
      const handoff = steer.mock.calls[0]![0] as { readonly id: string; readonly source: Record<string, unknown> }
      events.push({ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: handoff })
      if (suffix === 'stale') events.push({ type: 'turn/end', data: { turn: 1 } }, { type: 'turn/start', data: { turn: 2 } })
      else events.push({ type: 'user/message', data: { id: 'new-user-message', source: { kind: 'user' } } })
      await fx.tools.find(tool => tool.name === 'run_workflow')!.execute(inline, { agent: liveAgent, signal: exec.signal })
      expect(fx.service.startInline).toHaveBeenLastCalledWith(liveAgent, expect.anything(), {}, exec.signal, 'inline', false)
    }

    const requestFx = fixture({ approvalMode: 'generated-and-local' })
    requestFx.service.list.mockResolvedValueOnce({ entries: [], diagnostics: [] })
    const requestEvents: Array<{ type: string; data: Record<string, unknown> }> = []
    const requestSteer = vi.fn()
    const requestAgent = { session: { header: { cwd: 'C:\\workspace' }, events: requestEvents }, steer: requestSteer } as unknown as Agent
    await requestFx.command().handler({ agent: requestAgent, rawInput: 'coordinate inline only', signal: exec.signal })
    requestEvents.push({ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: requestSteer.mock.calls[0]![0] })
    requestEvents.push({ type: 'user/message', data: { id: 'tool-context', source: { kind: 'plugin', plugin: 'scouting-tool', form: 'notice', summary: 'scouting evidence added' } } })
    await expect(requestFx.tools.find(tool => tool.name === 'run_workflow')!.execute({ request: 'start another author pipeline' }, { agent: requestAgent, signal: exec.signal }))
      .rejects.toThrow(/source \+ manifest/u)
    expect(requestFx.service.create).not.toHaveBeenCalled()
    await requestFx.tools.find(tool => tool.name === 'run_workflow')!.execute(inline, { agent: requestAgent, signal: exec.signal })
    expect(requestFx.service.startInline).toHaveBeenLastCalledWith(requestAgent, expect.anything(), {}, exec.signal, 'inline', true)
  })

  it('preserves always approval and trusted-local named workflow gates', async () => {
    const always = fixture({ approvalMode: 'always' })
    always.service.list.mockResolvedValueOnce({ entries: [], diagnostics: [] })
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    const steer = vi.fn()
    const explicitAgent = { session: { header: { cwd: 'C:\\workspace' }, events }, steer } as unknown as Agent
    await always.command().handler({ agent: explicitAgent, rawInput: 'coordinate carefully', signal: exec.signal })
    events.push({ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: steer.mock.calls[0]![0] })
    const alwaysRun = always.tools.find(tool => tool.name === 'run_workflow')!
    await alwaysRun.execute({
      source: 'async function run(wf, args) { return args; }',
      manifest: { name: 'inline', description: 'inline', phases: ['run'], readOnly: true, maxAgents: 1, maxConcurrency: 1, patterns: ['classify-and-act'] },
      args: {},
    }, { agent: explicitAgent, signal: exec.signal })
    expect(always.service.startInline).toHaveBeenLastCalledWith(explicitAgent, expect.anything(), {}, exec.signal, 'inline', false)

    const named = fixture({ approvalMode: 'generated-and-local' })
    await named.tools.find(tool => tool.name === 'run_workflow')!.execute({ name: 'known', args: {} }, { agent: explicitAgent, signal: exec.signal })
    expect(named.service.startNamed).toHaveBeenLastCalledWith(explicitAgent, 'known', {}, exec.signal)
  })

  it('routes every durable management action', async () => {
    const fx = fixture()
    const manage = fx.tools.find(tool => tool.name === 'workflow_manage')!
    for (const action of ['runs', 'show', 'pause', 'resume', 'stop', 'rerun', 'resume-run', 'save', 'rename-run', 'rename-saved', 'revise', 'delete-run', 'delete-saved', 'prune']) {
      const value = await manage.execute({ action, target: 'run-1', name: 'next', value: 'change', scope: 'personal', force: true, dry_run: true, keep: 2, older_than_days: 3, background: action === 'rerun' }, exec)
      expect(value).toBeDefined()
    }
    expect(fx.service.rerun).toHaveBeenCalledTimes(2)
    expect(fx.service.deleteRun).toHaveBeenCalledWith(agent, 'run-1', true)
    expect(fx.service.prune).toHaveBeenCalledWith(agent, { keep: 2, olderThanMs: 259_200_000, dryRun: true })
  })

  it('routes /workflow help, lifecycle, authoring, saved execution, and fallback authoring', async () => {
    const fx = fixture()
    const invoke = async (rawInput: string) => await fx.command().handler({ agent, rawInput, signal: exec.signal }) as { kind: string; text: string }
    expect((await invoke('help')).text).toContain('/workflow create')
    expect((await invoke('list')).kind).toBe('success')
    expect((await invoke('runs --limit 1')).kind).toBe('success')
    expect((await invoke('runs --all')).kind).toBe('success')
    expect((await invoke('runs 1')).kind).toBe('error')
    expect((await invoke('show run-1')).kind).toBe('success')
    expect((await invoke('show --full run-1')).kind).toBe('success')
    expect((await invoke('pause run-1')).kind).toBe('success')
    expect((await invoke('resume run-1')).kind).toBe('success')
    expect((await invoke('stop run-1')).kind).toBe('success')
    expect((await invoke('create do something')).kind).toBe('success')
    expect((await invoke('rerun run-1 {"x":1}')).kind).toBe('success')
    expect((await invoke('resume-run run-1')).kind).toBe('success')
    expect((await invoke('save run-1 saved personal')).kind).toBe('success')
    expect((await invoke('rename-run run-1 Display Name')).kind).toBe('success')
    expect((await invoke('rename-saved old new personal')).kind).toBe('success')
    expect((await invoke('revise known improve it')).kind).toBe('success')
    expect((await invoke('revise --replace run-1 improve it')).kind).toBe('success')
    expect((await invoke('rename run-1 Better Run')).kind).toBe('success')
    expect((await invoke('delete --run --force run-1')).kind).toBe('success')
    expect((await invoke('delete-run run-1 --force')).kind).toBe('success')
    expect((await invoke('delete-saved known personal')).kind).toBe('success')
    expect((await invoke('prune --dry-run --keep 2 --older-than 3d')).kind).toBe('success')
    expect((await invoke('prune --older-than 24h')).kind).toBe('success')
    expect((await invoke('prune --unknown')).kind).toBe('error')
    expect((await invoke('known {"x":1}')).kind).toBe('success')
    expect((await invoke('known [1,2]')).kind).toBe('success')
    expect((await invoke('known "value"')).kind).toBe('success')
    expect(fx.service.startNamed).toHaveBeenLastCalledWith(agent, 'known', { question: '"value"' }, exec.signal, true)
    fx.service.list.mockResolvedValueOnce({ entries: [], diagnostics: [] })
    expect((await invoke('unknown request')).kind).toBe('success')
  })

  it('hands a free-text /workflow request to the current agent without blocking on authoring', async () => {
    const fx = fixture()
    fx.service.list.mockResolvedValueOnce({ entries: [], diagnostics: [] })
    fx.service.create.mockImplementationOnce(async () => await new Promise<never>(() => {}))
    const steer = vi.fn()
    const liveAgent = { session: { header: { cwd: 'C:\\workspace' } }, steer } as unknown as Agent

    const outcome = await Promise.race([
      fx.command().handler({ agent: liveAgent, rawInput: '请 review 当前版本代码修改与提交，但是不要做任何修改', signal: exec.signal }),
      new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 50)),
    ])

    expect(outcome).not.toBe('timed-out')
    expect(outcome).toMatchObject({ kind: 'success' })
    expect(fx.service.create).not.toHaveBeenCalled()
    expect(steer).toHaveBeenCalledOnce()
    expect(steer.mock.calls[0]![0]).toMatchObject({ id: expect.any(String), source: { kind: 'plugin', plugin: '@dsh-external/workflow', form: 'relay' } })
    expect((steer.mock.calls[0]![0] as { content: Array<{ text: string }> }).content[0]!.text).toContain('source + manifest (not request mode)')
    await expect(fx.command().handler({ agent: liveAgent, rawInput: 'create do something --wait', signal: exec.signal }))
      .resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('--wait is not supported') })
  })

  it('completes the real DSH command lifecycle before the handed-off workflow runs', async () => {
    const registeredTools: Array<{ name: string; execute(args: Record<string, unknown>, exec: unknown): Promise<unknown> }> = []
    class StubSubagents extends Service { constructor(ctx: Context) { super(ctx, 'subagents') } }
    class StubTools extends Service {
      constructor(ctx: Context) { super(ctx, 'tools') }
      register(value: { name: string; execute(args: Record<string, unknown>, exec: unknown): Promise<unknown> }): () => void { registeredTools.push(value); return () => {} }
      schemas(): unknown[] { return [] }
    }
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'dsh-workflow-command-lifecycle-'))
    const ctx = new Context()
    const sessions = await ctx.plugin(SessionStore)
    const commands = await ctx.plugin(CommandRuntime)
    const subagents = await ctx.plugin(StubSubagents)
    const tools = await ctx.plugin(StubTools)
    const workflow = await ctx.plugin(workflowPlugin, { approvalMode: 'generated-and-local' })
    try {
      const session = ctx.sessions.create(SessionId(`workflow-command-${Date.now()}`), { meta: { cwd } })
      const liveAgent = {
        id: session.id, ctx, session,
        steer(message: Parameters<Agent['steer']>[0]) {
          session.append('turn/start', { turn: 1 })
          session.append('user/message', message, { surfaceOp: 'append' })
        },
      } as unknown as Agent

      const outcome = await Promise.race([
        ctx.commands.execute(liveAgent, '/workflow inspect and coordinate', exec.signal),
        new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 250)),
      ])
      expect(outcome).not.toBe('timed-out')
      expect(session.events.filter(event => event.type === 'command/run' || event.type === 'command/done').map(event => event.type))
        .toEqual(['command/run', 'command/done'])
      const handoff = session.events.find(event => event.type === 'user/message')
      expect(handoff?.type === 'user/message' ? handoff.data.source : undefined)
        .toMatchObject({ kind: 'plugin', plugin: '@dsh-external/workflow', form: 'relay' })

      const runTool = registeredTools.find(tool => tool.name === 'run_workflow')!
      const result = await runTool.execute({
        source: 'async function run(wf, args) { return { ok: true }; }', wait: true,
        manifest: { name: 'lifecycle-proof', description: 'lifecycle proof', phases: ['run'], readOnly: true, maxAgents: 1, maxConcurrency: 1, patterns: ['classify-and-act'] },
      }, { agent: liveAgent, signal: exec.signal }) as { status: string; result: unknown }
      expect(result).toMatchObject({ status: 'completed', result: { ok: true } })
    } finally {
      await workflow.dispose(); await tools.dispose(); await subagents.dispose(); await commands.dispose(); await sessions.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('captures immutable Git evidence and starts the built-in scoped review from /workflow review', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'dsh-workflow-review-command-'))
    try {
      await execFileAsync('git', ['init'], { cwd, windowsHide: true })
      await execFileAsync('git', ['config', 'user.email', 'review@example.invalid'], { cwd, windowsHide: true })
      await execFileAsync('git', ['config', 'user.name', 'Review Test'], { cwd, windowsHide: true })
      await writeFile(path.join(cwd, 'subject.ts'), 'export const value = 1\n', 'utf8')
      await execFileAsync('git', ['add', 'subject.ts'], { cwd, windowsHide: true })
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd, windowsHide: true })
      await writeFile(path.join(cwd, 'subject.ts'), 'export const value = 2\n', 'utf8')

      const fx = fixture()
      const reviewAgent = { session: { id: 'review/session', header: { cwd } } } as unknown as Agent
      const result = await fx.command().handler({ agent: reviewAgent, rawInput: 'review --lean --risk high --requirement "preserve exported behavior" --test-evidence "pnpm test passed" --wait -- focus auth', signal: exec.signal }) as { kind: string; text: string }
      expect(result.kind).toBe('success')
      expect(JSON.parse(result.text)).toMatchObject({ status: 'completed' })
      const call = (fx.service.startInline.mock.calls as unknown[][]).at(-1)!
      expect(call[3]).toBe(exec.signal)
      expect(call[4]).toBe('built-in')
      const args = call[2] as { readonly lean: boolean; readonly reviewFocus: string; readonly packets: ReadonlyArray<{ readonly packetPath: string; readonly riskFlags: readonly string[] }> }
      expect(args).toMatchObject({ lean: true, reviewFocus: 'focus auth', packets: [{ riskFlags: ['routing-high'] }] })
      const body = await readFile(args.packets[0]!.packetPath, 'utf8')
      expect(body).toContain('preserve exported behavior')
      expect(body).toContain('pnpm test passed')
      expect(body).toContain('diff --git a/subject.ts b/subject.ts')
    } finally { await rm(cwd, { recursive: true, force: true }) }
  })

  it('returns command errors and cancellation without leaking exceptions', async () => {
    const fx = fixture()
    const invoke = async (rawInput: string) => await fx.command().handler({ agent, rawInput, signal: exec.signal }) as { kind: string; text: string }
    expect((await invoke('create')).kind).toBe('error')
    expect((await invoke('rerun')).kind).toBe('error')
    fx.service.pause.mockReturnValueOnce(false)
    expect((await invoke('pause missing')).kind).toBe('error')
    fx.service.confirm.mockResolvedValueOnce(false)
    expect(await invoke('known')).toMatchObject({ kind: 'error', text: 'workflow cancelled' })
  })
})
