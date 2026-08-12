import { describe, expect, it } from 'vitest'
import { listBuiltinWorkflows, listWorkflowPatterns } from '../src/builtins.js'
import { runRestrictedWorkflowScript } from '../src/runtime.js'
import { validateRestrictedWorkflowSource } from '../src/source-policy.js'
import type { WorkflowApi, WorkflowTaskResult } from '../src/types.js'

function result(name: string, prompt: string): WorkflowTaskResult {
  return { taskId: `task-${name}`, name, status: 'completed', finalText: prompt, startedAt: 1, endedAt: 2 }
}

function api(): WorkflowApi {
  return {
    runId: 'builtins', args: {}, budget: { total: null, spent: () => 0, remaining: () => Infinity },
    phase: async (_name, fn) => await fn(), spawnAgent: async input => ({ taskId: input.name, name: input.name }),
    runAgent: async input => {
      if (input.name.includes('primary')) return { ...result(input.name, input.prompt), structured: { specVerdict: input.prompt.includes('No binding requirements') ? 'not-verifiable' : 'compliant', qualityVerdict: 'approved', findings: [], unverifiedRequirements: [] } }
      if (input.name === 'final-review-synthesis') return { ...result(input.name, input.prompt), structured: { summary: 'review complete' } }
      return result(input.name, input.prompt)
    }, wait: async id => result(id, id),
    snapshot: async id => ({ taskId: id, name: id, status: 'running', startedAt: 1 }), output: async id => ({ taskId: id, name: id, status: 'running', startedAt: 1 }),
    send: async () => {}, stop: async () => {},
    parallel: async (thunks, options) => {
      const output = []
      for (const thunk of thunks) output.push(await thunk())
      void options
      return output
    },
    pipeline: async (items, ...stages) => await Promise.all(items.map(async (item, index) => { let value: unknown = item; for (const stage of stages) value = await stage(value, item, index); return value })),
    synthesize: async input => ({ text: `synthesized:${JSON.stringify(input.inputs)}` }), workflow: async name => name,
    artifact: async name => ({ name, path: name }), log: () => {},
  }
}

describe('KodaX-parity built-ins and workflow patterns', () => {
  it('ships two concrete workflows and all six canonical patterns', () => {
    const builtins = listBuiltinWorkflows()
    const patterns = listWorkflowPatterns()
    expect(builtins.map(item => item.manifest.name)).toEqual(['parallel-investigation', 'scoped-review'])
    expect(patterns.map(item => item.manifest.name)).toEqual(['classify-and-act', 'fan-out-and-synthesize', 'adversarial-verification', 'generate-and-filter', 'tournament', 'loop-until-done'])
    for (const item of [...builtins, ...patterns]) {
      expect(item.execution).toBe('trusted-package')
      if (item.source !== undefined) expect(() => validateRestrictedWorkflowSource(item.source!, item.manifest.name)).not.toThrow()
      else expect(item.run).toBeTypeOf('function')
    }
  })

  it.each([...listBuiltinWorkflows(), ...listWorkflowPatterns()])('executes $manifest.name through the restricted capability runtime', async workflow => {
    const args = workflow.manifest.name === 'parallel-investigation'
      ? { question: 'why', angles: ['code', 'tests'] }
      : workflow.manifest.name === 'scoped-review'
        ? { packets: [{ packetPath: 'packet.json', contentHash: 'abc', rangeId: 'r1', partitionKey: 'p1', label: 'scope', scopePaths: ['src'], riskFlags: [], budget: { maxBytes: 100, maxLines: 10, maxLineChars: 100 }, evidenceChunks: [], requirementsPresent: false, testEvidencePresent: false }] }
        : { request: 'solve', angles: ['code', 'tests'], styles: ['direct', 'risk'], maxRounds: 2 }
    const value = workflow.source === undefined
      ? await workflow.run!(api(), args)
      : await runRestrictedWorkflowScript({ source: workflow.source, wf: api(), args, syncTimeoutMs: 100, wallTimeoutMs: 1_000 })
    expect(value).toBeDefined()
  })

  it('preserves parallel investigation findings, degraded state, and structured lane schemas', async () => {
    const workflow = listBuiltinWorkflows().find(item => item.manifest.name === 'parallel-investigation')!
    const calls: Array<{ readonly name: string; readonly outputSchema: unknown }> = []
    const controlled = api()
    controlled.runAgent = async input => {
      calls.push({ name: input.name, outputSchema: input.outputSchema })
      if (input.name === 'investigate-2') return null
      return { ...result(input.name, ''), structured: { finding: `finding:${input.name}` } }
    }
    const value = await runRestrictedWorkflowScript({ source: workflow.source!, wf: controlled, args: { question: 'why', targets: ['code', 'tests'], maxAgents: 3 }, syncTimeoutMs: 100, wallTimeoutMs: 1_000 }) as { synthesis: string; findings: Array<{ status: string; text: string }>; degraded: boolean }
    expect(value).toMatchObject({ degraded: true, findings: [{ status: 'completed', text: 'finding:investigate-1' }, { status: 'failed' }] })
    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.outputSchema !== undefined)).toBe(true)
  })

  it('runs generate-and-filter through a final synthesis phase', async () => {
    const workflow = listWorkflowPatterns().find(item => item.manifest.name === 'generate-and-filter')!
    let synthesisCalls = 0
    const controlled = api()
    controlled.synthesize = async input => { synthesisCalls += 1; return { text: `final:${JSON.stringify(input.inputs)}` } }
    const value = await runRestrictedWorkflowScript({ source: workflow.source!, wf: controlled, args: { request: 'options' }, syncTimeoutMs: 100, wallTimeoutMs: 1_000 })
    expect(synthesisCalls).toBe(1)
    expect(value).toMatchObject({ text: expect.stringContaining('final:') })
  })
})
