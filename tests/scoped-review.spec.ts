import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { scopedReviewWorkflow, writeReviewPackets, type ReviewPacketMetadata } from '../src/scoped-review.js'
import type { WorkflowApi, WorkflowTaskResult } from '../src/types.js'

function packet(overrides: Partial<ReviewPacketMetadata> = {}): ReviewPacketMetadata {
  return {
    packetPath: 'packets/p1.json', contentHash: 'content-1', rangeId: 'range-1', partitionKey: 'part-1', label: 'core',
    scopePaths: ['src'], riskFlags: ['routing-high'], budget: { maxBytes: 10_000, maxLines: 200, maxLineChars: 200 },
    evidenceChunks: [{ path: 'packets/p1-source.txt', contentHash: 'chunk-1' }], requirementsPresent: true, testEvidencePresent: true,
    ...overrides,
  }
}

function completed(name: string, structured: unknown): WorkflowTaskResult {
  return { taskId: `task-${name}`, name, status: 'completed', finalText: name, structured, verification: { ok: true, reasons: [], enforcement: 'hard' }, startedAt: 1, endedAt: 2 }
}

function api(options: { readonly wrongSpec?: boolean; readonly noFindings?: boolean; readonly disposition?: 'confirmed' | 'refuted' | 'unresolved'; readonly severityWithoutReason?: boolean } = {}) {
  const calls: string[] = []
  const artifact = vi.fn(async (name: string) => ({ name, path: `/artifacts/${name}.json` }))
  const value: WorkflowApi = {
    runId: 'review-run', args: {}, budget: { total: null, spent: () => 0, remaining: () => Infinity },
    phase: async (_name, fn) => await fn(), spawnAgent: async input => ({ taskId: input.name, name: input.name }),
    runAgent: async input => {
      calls.push(input.name)
      if (input.name.includes('primary')) return completed(input.name, {
        specVerdict: options.wrongSpec ? 'compliant' : 'issues', qualityVerdict: 'needs-fixes', unverifiedRequirements: [],
        findings: options.noFindings ? [] : [{ severity: input.name.startsWith('second-primary') ? 'critical' : 'high', location: 'src/a.ts:10', claim: 'unchecked value', evidence: input.name.startsWith('second-primary') ? 'a second independent observation' : 'the packet shows an unchecked value', suggestedFix: 'validate it' }],
      })
      if (input.name.startsWith('verifier-')) {
        const line = input.prompt.split('\n').find(item => item.startsWith('Candidates: '))!
        const candidates = JSON.parse(line.slice('Candidates: '.length)) as { findingId: string }[]
        return completed(input.name, { findings: candidates.map(item => ({ findingId: item.findingId, disposition: options.disposition ?? 'confirmed', evidence: 'confirmed against the packet', ...(options.severityWithoutReason ? { effectiveSeverity: 'medium' } : {}) })) })
      }
      return completed(input.name, { summary: 'one confirmed high-severity issue' })
    },
    wait: async id => completed(id, {}), snapshot: async id => ({ taskId: id, name: id, status: 'running', startedAt: 1 }), output: async id => ({ taskId: id, name: id, status: 'running', startedAt: 1 }),
    send: async () => {}, stop: async () => {},
    parallel: async thunks => await Promise.all(thunks.map(async thunk => await thunk())),
    pipeline: async (items, ...stages) => await Promise.all(items.map(async (item, index) => { let current: unknown = item; for (const stage of stages) current = await stage(current, item, index); return current })),
    synthesize: async () => ({ text: 'unused' }), workflow: async () => null, artifact, log: () => {},
  }
  return { value, calls, artifact }
}

describe('KodaX scoped-review contract', () => {
  it('uses two primaries for high-risk packets, verifies every finding, and writes the audit artifact', async () => {
    const fake = api()
    const result = await scopedReviewWorkflow.run!(fake.value, { packets: [packet()], lean: true })
    expect(fake.calls.filter(name => name.includes('primary'))).toHaveLength(2)
    expect(fake.calls).toEqual(expect.arrayContaining(['verifier-part-1', 'final-review-synthesis']))
    expect(result).toMatchObject({ summary: 'one confirmed high-severity issue', packetResults: [{ contentHash: 'content-1', result: { specVerdict: 'issues', actionable: [{ disposition: 'confirmed', severity: 'critical' }], unqualifiedApprovalAllowed: false } }] })
    expect(fake.artifact).toHaveBeenCalledWith('scoped-review-audit', expect.any(Array))
  })

  it('rejects missing packets and forbids a spec approval when requirements are absent', async () => {
    await expect(scopedReviewWorkflow.run!(api().value, { packets: [] })).rejects.toThrow(/non-empty packets/u)
    await expect(scopedReviewWorkflow.run!(api({ wrongSpec: true }).value, { packets: [packet({ requirementsPresent: false, riskFlags: [] })] })).rejects.toThrow(/not-verifiable/u)
  })

  it('accepts a clean low-risk packet without launching a verifier', async () => {
    const fake = api({ noFindings: true })
    const result = await scopedReviewWorkflow.run!(fake.value, { packets: [packet({ riskFlags: [] })] })
    expect(fake.calls).toEqual(['primary-part-1', 'final-review-synthesis'])
    expect(result).toMatchObject({ packetResults: [{ result: { actionable: [], unqualifiedApprovalAllowed: false } }] })
  })

  it('removes refuted findings and ignores an unreasoned severity change', async () => {
    const refuted = await scopedReviewWorkflow.run!(api({ disposition: 'refuted' }).value, { packets: [packet({ riskFlags: [] })] })
    expect(refuted).toMatchObject({ packetResults: [{ result: { actionable: [], audit: { findings: [{ disposition: 'refuted' }] } } }] })
    const unreasoned = await scopedReviewWorkflow.run!(api({ severityWithoutReason: true }).value, { packets: [packet({ riskFlags: [] })] })
    expect(unreasoned).toMatchObject({ packetResults: [{ result: { actionable: [{ severity: 'high' }] } }] })
  })

  it.each([
    [null, /must be an object/u],
    [{ ...packet(), packetPath: '' }, /packetPath/u],
    [{ ...packet(), scopePaths: null }, /scopePaths/u],
    [{ ...packet(), scopePaths: [] }, /scopePaths/u],
    [{ ...packet(), evidenceChunks: null }, /evidenceChunks/u],
    [{ ...packet(), evidenceChunks: [{ path: '', contentHash: 'chunk-1' }] }, /evidenceChunks\[0\]\.path/u],
    [{ ...packet(), evidenceChunks: [{ path: 'packets/p1-source.txt', contentHash: '' }] }, /evidenceChunks\[0\]\.contentHash/u],
    [{ ...packet(), riskFlags: null }, /riskFlags/u],
    [{ ...packet(), riskFlags: ['unknown'] }, /riskFlags/u],
    [{ ...packet(), requirementsPresent: 'yes' }, /evidence flags/u],
    [{ ...packet(), budget: null }, /budget/u],
    [{ ...packet(), budget: { maxBytes: 0, maxLines: 1, maxLineChars: 1 } }, /budget/u],
  ])('rejects malformed packet metadata %#', async (invalid, expected) => {
    await expect(scopedReviewWorkflow.run!(api().value, { packets: [invalid] })).rejects.toThrow(expected)
  })
})

describe('immutable review packet writer', () => {
  it('deterministically partitions explicit diff bytes and records requirements and test evidence', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'dsh-review-packets-'))
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts', '@@ -1 +1 @@', '-old', '+new',
      'diff --git a/docs/README.md b/docs/README.md', '@@ -1 +1 @@', '-before', '+after', '',
    ].join('\n')
    try {
      const input = { cwd, sessionId: '../unsafe/session', label: 'captured', diff, requirements: ['must preserve behavior'], testEvidence: ['pnpm test passed'], routingRisk: 'high' as const }
      const first = await writeReviewPackets(input)
      const second = await writeReviewPackets(input)
      expect(first.map(item => item.partitionKey)).toEqual(['docs/docs', 'src/source'])
      expect(first.map(item => item.contentHash)).toEqual(second.map(item => item.contentHash))
      expect(first.every(item => item.riskFlags[0] === 'routing-high' && item.requirementsPresent && item.testEvidencePresent)).toBe(true)
      expect(first.flatMap(item => item.scopePaths).sort()).toEqual(['docs/README.md', 'src/a.ts'])
      expect(first[0]!.packetPath).toContain(`${path.sep}unsafe_session${path.sep}`)
      expect(await readFile(first[0]!.packetPath, 'utf8')).toContain('must preserve behavior')
      expect(Object.isFrozen(first)).toBe(true)
      expect(Object.isFrozen(first[0])).toBe(true)
    } finally { await rm(cwd, { recursive: true, force: true }) }
  })

  it('chunks oversized evidence within byte, line, and line-width caps without losing payload', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'dsh-review-large-'))
    const payload = 'x'.repeat(6_500)
    try {
      const [packet] = await writeReviewPackets({ cwd, sessionId: 's', label: 'large', diff: `diff --git a/packages/a/large.ts b/packages/a/large.ts\n@@ -1 +1 @@\n+${payload}\n`, budget: { maxBytes: 1_200, maxLines: 12, maxLineChars: 300 } })
      expect(packet!.evidenceChunks.length).toBeGreaterThan(1)
      const chunks = await Promise.all(packet!.evidenceChunks.map(async chunk => await readFile(chunk.path, 'utf8')))
      expect(chunks.join('').match(/x/gu)?.length).toBe(payload.length)
      for (const chunk of chunks) {
        expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(1_200)
        expect(chunk.split(/\r?\n/u).length).toBeLessThanOrEqual(12)
        expect(chunk.split(/\r?\n/u).every(line => line.length <= 300)).toBe(true)
      }
    } finally { await rm(cwd, { recursive: true, force: true }) }
  })

  it('changes range identity for refs, scope, and captured bytes', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'dsh-review-range-'))
    const base = { cwd, sessionId: 's', label: 'range', diff: 'diff --git a/a.ts b/a.ts\n+one\n', baseRef: 'a'.repeat(40), headRef: 'b'.repeat(40), scope: 'compare' as const }
    try {
      const [first] = await writeReviewPackets(base)
      const [changedRef] = await writeReviewPackets({ ...base, headRef: 'c'.repeat(40) })
      const [changedBytes] = await writeReviewPackets({ ...base, diff: `${base.diff}+two\n` })
      expect(new Set([first!.rangeId, changedRef!.rangeId, changedBytes!.rangeId]).size).toBe(3)
    } finally { await rm(cwd, { recursive: true, force: true }) }
  })
})
