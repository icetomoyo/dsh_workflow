import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkflowRunStore } from '../src/store.js'
import type { WorkflowRunSnapshot, WorkflowTaskResult } from '../src/types.js'

function snapshot(runId: string, status: WorkflowRunSnapshot['status'], startedAt: number): WorkflowRunSnapshot {
  return { runId, workflow: 'demo', displayName: 'Demo', status, source: 'inline', execution: 'capability-generated', startedAt, ...(status === 'running' ? {} : { endedAt: startedAt + 1 }), totalSpawned: 0, activeAgents: 0, eventCount: 0, artifacts: [] }
}

describe('durable workflow run store', () => {
  it('writes an append-only graph, artifacts, snapshots, and replay cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-store-'))
    const store = new WorkflowRunStore(root, () => 10)
    const first = store.create('run-1')
    first.append('workflow-started', { runId: 'run-1' })
    first.append('workflow-log', { message: 'progress' })
    const artifact = first.artifact('review/evidence', { ok: true })
    const result: WorkflowTaskResult = { taskId: 'task-1', name: 'worker', status: 'completed', finalText: 'ok', startedAt: 1, endedAt: 2 }
    const key = first.cacheKey({ name: 'worker', prompt: 'p' }, 1)
    first.setCached(key, result)
    first.writeSnapshot({ ...snapshot('run-1', 'completed', 1), artifacts: [artifact], eventCount: 2 })
    const second = store.create('run-2')
    expect(second.getCached(key, 'run-1')).toEqual(result)
    expect(store.getEvents('run-1').map(event => event.type)).toEqual(['workflow-started', 'workflow-log'])
    expect(store.get('run-1')?.artifacts[0]?.name).toBe('review/evidence')
    const collisionSafe = first.artifact('review_evidence', { distinct: true })
    expect(collisionSafe.path).not.toBe(artifact.path)
    expect(() => first.artifact('review/evidence', { overwrite: true })).toThrow(/already written/u)
  })

  it('resolves exact ids and aliases, rejects live deletion, and prunes terminal history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-store-'))
    const store = new WorkflowRunStore(root, () => 100)
    for (const [id, status, time] of [['run-a', 'completed', 1], ['run-b', 'failed', 2], ['run-c', 'running', 3]] as const) {
      const writer = store.create(id); writer.writeSnapshot(snapshot(id, status, time))
    }
    expect(store.resolveIdentity('run-a')).toMatchObject({ kind: 'run', runId: 'run-a' })
    expect(store.resolveIdentity('Demo')).toMatchObject({ kind: 'ambiguous' })
    expect(() => store.delete('run-c')).toThrow(/not terminal/u)
    expect(store.prune({ keep: 1, dryRun: true }).candidates).toEqual(['run-a'])
    expect(store.prune({ keep: 1 }).deleted).toEqual(['run-a'])
    expect(store.get('run-a')).toBeUndefined()
  })

  it('never replays failed or unverified results and binds absolute partitions to their project owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-owner-'))
    const store = new WorkflowRunStore(root, () => 1, 'c:/project-a')
    const first = store.create('run-failed')
    const key = first.cacheKey({ name: 'worker', prompt: 'same' }, 1)
    first.setCached(key, { taskId: 'task-1', name: 'worker', status: 'failed', finalText: '', startedAt: 1, endedAt: 2 })
    expect(store.create('run-next').getCached(key, 'run-failed')).toBeUndefined()
    expect(() => new WorkflowRunStore(root, () => 1, 'c:/project-b')).toThrow(/different project/u)
  })
})
