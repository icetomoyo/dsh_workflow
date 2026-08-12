import { describe, expect, it, vi } from 'vitest'
import { runRestrictedWorkflowScript } from '../src/runtime.js'
import { validateRestrictedWorkflowSource } from '../src/source-policy.js'
import type { WorkflowApi } from '../src/types.js'

function api(): WorkflowApi {
  const tasks = new Map<string, string>()
  return {
    runId: 'run-1', args: { value: 2 }, budget: { total: 100, spent: () => 10, remaining: () => 90 },
    phase: async (_name, fn) => await fn(),
    spawnAgent: async input => { const taskId = `task-${tasks.size + 1}`; tasks.set(taskId, input.prompt); return { taskId, name: input.name } },
    runAgent: async input => ({ taskId: 'task-run', name: input.name, status: 'completed', finalText: input.prompt, startedAt: 1, endedAt: 2 }),
    wait: async taskId => ({ taskId, name: 'waited', status: 'completed', finalText: tasks.get(taskId) ?? '', startedAt: 1, endedAt: 2 }),
    snapshot: async taskId => ({ taskId, name: 'snap', status: 'running', startedAt: 1 }),
    output: async taskId => ({ taskId, name: 'out', status: 'running', startedAt: 1 }),
    send: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    parallel: async thunks => await Promise.all(thunks.map(async thunk => await thunk())),
    pipeline: async (items, ...stages) => await Promise.all(items.map(async (item, index) => { let value: unknown = item; for (const stage of stages) value = await stage(value, item, index); return value })),
    synthesize: async input => ({ text: JSON.stringify(input.inputs) }), workflow: async (name, args) => ({ name, args }),
    artifact: async name => ({ name, path: `/artifacts/${name}.json` }), log: vi.fn(),
  }
}

describe('restricted workflow runner', () => {
  it('exposes the complete WorkflowApi through a JSON boundary', async () => {
    const value = await runRestrictedWorkflowScript({
      source: `async function run(wf, args) {
        return await wf.phase('work', async () => {
          const handle = await wf.spawnAgent({ name: 'one', prompt: 'hello' });
          await wf.send(handle.taskId, 'steer');
          const waited = await wf.wait(handle.taskId);
          const nested = await wf.workflow('nested', { n: args.value });
          const artifact = await wf.artifact('evidence', { waited });
          wf.log({ message: 'done', data: { taskId: handle.taskId } });
          return { waited: waited.finalText, nested, artifact, remaining: wf.budget.remaining() };
        });
      }`,
      wf: api(), args: { value: 2 }, syncTimeoutMs: 100, wallTimeoutMs: 1_000,
    })
    expect(value).toEqual({ waited: 'hello', nested: { name: 'nested', args: { n: 2 } }, artifact: { name: 'evidence', path: '/artifacts/evidence.json' }, remaining: 90 })
  })

  it.each([
    ['async function run(wf, args) { return process.cwd(); }', /process/u],
    ['async function run(wf, args) { return await import("x"); }', /import/u],
    ['async function run(wf, args) { return fetch("x"); }', /network/u],
    ['async function run(wf, args) { return setTimeout(() => 1, 1); }', /timers/u],
  ])('rejects direct host effects', (source, expected) => {
    expect(() => validateRestrictedWorkflowSource(source)).toThrow(expected)
  })

  it('guards nondeterminism and synchronous infinite loops', async () => {
    await expect(runRestrictedWorkflowScript({ source: 'async function run(wf, args) { return Math.random(); }', wf: api(), syncTimeoutMs: 100, wallTimeoutMs: 1_000 })).rejects.toThrow(/Math\.random is disabled/u)
    await expect(runRestrictedWorkflowScript({ source: 'async function run(wf, args) { for (;;) {} }', wf: api(), syncTimeoutMs: 20, wallTimeoutMs: 100 })).rejects.toThrow(/UNBOUNDED_LOOP|timed out/u)
  })

  it('preserves deterministic Math helpers while blocking only random', async () => {
    const value = await runRestrictedWorkflowScript({ source: 'async function run(wf, args) { return Math.min(9, Math.floor(2.8)); }', wf: api(), syncTimeoutMs: 100, wallTimeoutMs: 1_000 })
    expect(value).toBe(2)
    await expect(runRestrictedWorkflowScript({ source: 'async function run(wf, args) { return new Date(0).toISOString(); }', wf: api(), syncTimeoutMs: 100, wallTimeoutMs: 1_000 })).resolves.toBe('1970-01-01T00:00:00.000Z')
    await expect(runRestrictedWorkflowScript({ source: 'async function run(wf, args) { return Date.now(); }', wf: api(), syncTimeoutMs: 100, wallTimeoutMs: 1_000 })).rejects.toThrow(/Date\.now is disabled/u)
  })

  it('keeps computed constructor chains inside the isolated guest heap', async () => {
    await expect(runRestrictedWorkflowScript({
      source: `async function run(wf, args) { return wf.phase["con" + "structor"]("return process.version")(); }`,
      wf: api(), syncTimeoutMs: 100, wallTimeoutMs: 1_000,
    })).rejects.toThrow(/process.*not defined/u)
  })

  it('quiesces an unawaited host RPC before the runner completes', async () => {
    let resolveArtifact!: () => void
    let artifactSettled = false
    const controlled = api()
    const artifact = vi.fn(async (name: string) => {
      await new Promise<void>(resolve => { resolveArtifact = resolve })
      artifactSettled = true
      return { name, path: `/artifacts/${name}.json` }
    })
    controlled.artifact = artifact
    let runnerSettled = false
    const runner = runRestrictedWorkflowScript({
      source: `async function run(wf, args) { void wf.artifact('unawaited', { durable: true }); return 'done'; }`,
      wf: controlled, syncTimeoutMs: 100, wallTimeoutMs: 1_000,
    }).finally(() => { runnerSettled = true })
    await vi.waitFor(() => expect(artifact).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(runnerSettled).toBe(false)
    resolveArtifact()
    await expect(runner).resolves.toBe('done')
    expect(artifactSettled).toBe(true)
  })

  it('closes the capability bridge, cancels its owner, and quiesces host RPCs after a wall timeout', async () => {
    let resolveAgent!: () => void
    let agentSettled = false
    const controlled = api()
    controlled.runAgent = async input => {
      await new Promise<void>(resolve => { resolveAgent = resolve })
      agentSettled = true
      return { taskId: 'late', name: input.name, status: 'completed', finalText: 'late', startedAt: 1, endedAt: 2 }
    }
    const artifact = vi.fn(controlled.artifact)
    controlled.artifact = artifact
    const onTimeout = vi.fn(() => { setTimeout(resolveAgent, 10) })
    await expect(runRestrictedWorkflowScript({
      source: `async function run(wf, args) { await wf.runAgent({ name: 'slow', prompt: 'wait' }); return await wf.artifact('late', { unsafe: true }); }`,
      wf: controlled, syncTimeoutMs: 100, wallTimeoutMs: 20, onTimeout,
    })).rejects.toThrow(/timed out/u)
    expect(onTimeout).toHaveBeenCalledOnce()
    expect(agentSettled).toBe(true)
    expect(artifact).not.toHaveBeenCalled()
  })

  it('isolates ordinary parallel branch failures', async () => {
    const result = await runRestrictedWorkflowScript({ source: `async function run(wf, args) { return await wf.parallel([async () => 1, async () => { throw new Error('ordinary budget note'); }, async () => 3], { concurrency: 2 }); }`, wf: api(), syncTimeoutMs: 100, wallTimeoutMs: 1_000 })
    expect(result).toEqual([1, null, 3])
  })

  it('propagates typed run-control failures through combinators', async () => {
    const controlled = api()
    controlled.runAgent = async () => {
      const error = new Error('agent limit exceeded')
      error.name = 'WorkflowControlError'
      throw error
    }
    await expect(runRestrictedWorkflowScript({ source: `async function run(wf, args) { return await wf.parallel([async () => await wf.runAgent({ name: 'blocked', prompt: 'blocked' })]); }`, wf: controlled, syncTimeoutMs: 100, wallTimeoutMs: 1_000 })).rejects.toThrow(/agent limit exceeded/u)
  })

  it('enforces a lossless JSON boundary and normalizes an undefined result', async () => {
    await expect(runRestrictedWorkflowScript({ source: `async function run(wf, args) { return { invalid: undefined }; }`, wf: api(), syncTimeoutMs: 100, wallTimeoutMs: 1_000 })).rejects.toThrow(/non-JSON undefined/u)
    await expect(runRestrictedWorkflowScript({ source: `async function run(wf, args) { return 0 / 0; }`, wf: api(), syncTimeoutMs: 100, wallTimeoutMs: 1_000 })).rejects.toThrow(/non-finite/u)
    await expect(runRestrictedWorkflowScript({ source: `async function run(wf, args) { return; }`, wf: api(), syncTimeoutMs: 100, wallTimeoutMs: 1_000 })).resolves.toBeNull()
  })
})
