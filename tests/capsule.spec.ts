import { describe, expect, it } from 'vitest'
import {
  createWorkflowCapsule, DSH_WORKFLOW_API_VERSION, DSH_WORKFLOW_FORMAT,
  DSH_WORKFLOW_VERSION, validateWorkflowArgs, validateWorkflowCapsule,
} from '../src/capsule.js'

const manifest = {
  name: 'review-many',
  description: 'Review independent targets and synthesize the findings.',
  phases: ['review', 'synthesize'],
  readOnly: true,
  plannedAgents: 3,
  maxAgents: 6,
  maxConcurrency: 3,
  tokenBudget: 24_000,
  mayUseWorktree: false,
  patterns: ['fan-out-and-synthesize', 'adversarial-verification'],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { targets: { type: 'array', items: { type: 'string' } } },
    required: ['targets'],
  },
}

const source = 'async function run(wf, args) { return await wf.phase("review", async () => args.targets); }'

function valid() {
  return {
    format: DSH_WORKFLOW_FORMAT,
    version: DSH_WORKFLOW_VERSION,
    workflowApiVersion: DSH_WORKFLOW_API_VERSION,
    minDshVersion: '0.0.1-rc.2',
    manifest,
    source,
    intent: { taskClass: 'review', patterns: manifest.patterns, reusableFor: ['large reviews'] },
    inputs: { description: 'Object with target paths.', examples: [{ targets: ['src'] }] },
    requires: { environment: ['git-repo'], tools: ['read'], modelTiers: ['balanced', 'deep'] },
    provenance: { createdAt: '2026-08-13T00:00:00.000Z', dshVersion: '0.0.1-rc.2', pluginVersion: '0.1.0' },
  }
}

describe('workflow capsule and manifest', () => {
  it('preserves the complete versioned capability contract', () => {
    const capsule = validateWorkflowCapsule(valid(), { maxAgents: 8, maxConcurrency: 4 })
    expect(capsule.manifest).toMatchObject({
      name: 'review-many', phases: ['review', 'synthesize'], readOnly: true,
      plannedAgents: 3, maxAgents: 6, maxConcurrency: 3, tokenBudget: 24_000,
      patterns: ['fan-out-and-synthesize', 'adversarial-verification'],
    })
    expect(capsule.requires).toEqual({ environment: ['git-repo'], tools: ['read'], modelTiers: ['balanced', 'deep'] })
  })

  it.each([
    [{ ...valid(), format: 'kodax.workflow' }, /format must be "dsh\.workflow"/u],
    [{ ...valid(), version: 2 }, /version must be 1/u],
    [{ ...valid(), workflowApiVersion: 2 }, /workflowApiVersion must be 1/u],
    [{ ...valid(), extra: true }, /unsupported field "extra"/u],
    [{ ...valid(), manifest: { ...manifest, name: '../escape' } }, /manifest\.name/u],
    [{ ...valid(), manifest: { ...manifest, plannedAgents: 7 } }, /plannedAgents/u],
    [{ ...valid(), manifest: { ...manifest, maxConcurrency: 7 } }, /maxConcurrency/u],
    [{ ...valid(), manifest: { ...manifest, maxAgents: 9 } }, /deployment ceiling/u],
    [{ ...valid(), manifest: { ...manifest, patterns: ['unknown'] } }, /unsupported id/u],
    [{ ...valid(), requires: { modelTiers: ['turbo'] } }, /unsupported tier/u],
    [{ ...valid(), source: ' ' }, /source must be a non-empty string/u],
  ])('fails malformed or unsupported capsules before execution', (value, expected) => {
    expect(() => validateWorkflowCapsule(value, { maxAgents: 8, maxConcurrency: 4 })).toThrow(expected)
  })

  it('validates arguments using the capsule schema subset', () => {
    const capsule = validateWorkflowCapsule(valid())
    expect(() => validateWorkflowArgs(capsule, { targets: ['src', 'tests'] })).not.toThrow()
    expect(() => validateWorkflowArgs(capsule, { targets: [42] })).toThrow(/args\.targets\.0 must be a string/u)
    expect(() => validateWorkflowArgs(capsule, {})).toThrow(/args\.targets is required/u)
    expect(() => validateWorkflowArgs(capsule, { targets: [], extra: true })).toThrow(/args\.extra is not allowed/u)
  })

  it('creates a canonical capsule without admitting unknown fields', () => {
    const capsule = createWorkflowCapsule({ minDshVersion: '0.0.1-rc.2', manifest: validateWorkflowCapsule(valid()).manifest, source })
    expect(capsule).toMatchObject({ format: 'dsh.workflow', version: 1, workflowApiVersion: 1 })
  })
})
