import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { randomUUID } from 'node:crypto'
import { createWorkflowCapsule, validateWorkflowCapsule } from './capsule.js'
import { resolveReadOnlyToolFilter } from './engine.js'
import { assertRestrictedWorkflowQuality, lintRestrictedWorkflowSource, validateRestrictedWorkflowSource } from './source-policy.js'
import { runRestrictedWorkflowScript } from './runtime.js'
import type { ModelTierRoute, ResolvedWorkflowConfig, WorkflowApi, WorkflowCapsule, WorkflowSpawnAgentInput, WorkflowTaskResult } from './types.js'

const AUTHOR_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    manifest: { type: 'object', additionalProperties: true },
    source: { type: 'string' },
    intent: { type: 'object', additionalProperties: true },
    inputs: { type: 'object', additionalProperties: true },
    requires: { type: 'object', additionalProperties: true },
  },
  required: ['manifest', 'source', 'intent', 'inputs', 'requires'],
}

function text(blocks: readonly ContentBlock[]): string {
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n')
}

async function oneShot(
  subagents: SubagentRuntime,
  route: ModelTierRoute,
  parent: Agent,
  prompt: string,
  signal: AbortSignal,
  config: ResolvedWorkflowConfig,
  outputSchema?: ObjectJsonSchema,
): Promise<{ readonly text: string; readonly structured?: unknown }> {
  const provider = subagents.getProvider(route.subagentProvider)
  if (provider === undefined) throw new Error(`workflow authoring provider "${route.subagentProvider}" is unavailable`)
  if (!provider.capabilities.toolFilter) throw new Error(`workflow authoring provider "${route.subagentProvider}" cannot enforce read-only scouting`)
  if (outputSchema !== undefined && !provider.capabilities.outputSchema) throw new Error(`workflow authoring provider "${route.subagentProvider}" cannot produce structured output`)
  const run = await subagents.start(route.subagentProvider, {
    label: outputSchema === undefined ? 'workflow-scout' : 'workflow-author',
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal,
    toolFilter: resolveReadOnlyToolFilter(parent, config.readOnlyAllowedTools, config.readOnlyToolFilter.deny),
    agentOptions: {
      ...(route.provider === undefined ? {} : { provider: route.provider }),
      ...(route.model === undefined ? {} : { model: route.model }),
      ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }),
    },
    ...(outputSchema === undefined ? {} : { outputSchema }),
  })
  try {
    const result = await run.result
    if (result.stopReason !== 'completed') throw new Error(`workflow authoring child ${result.stopReason}`)
    return { text: text(result.output), ...(result.structured === undefined ? {} : { structured: result.structured }) }
  } finally { await run.dispose() }
}

function authorPrompt(request: string, scout: string, existing?: WorkflowCapsule, change?: string): string {
  return `Author one reusable DSH workflow capsule payload.

The runtime contract is async function run(wf, args). Available capabilities:
- wf.phase(name, fn), wf.spawnAgent(input), wf.runAgent(input), wf.wait/snapshot/output/send/stop
- wf.parallel(thunks, {concurrency}), wf.pipeline(items, ...stages), wf.synthesize({inputs,rubric})
- one-level wf.workflow(name,args), wf.artifact(name,value), wf.log(message), wf.budget
- task input supports name, phase, prompt, scopeSummary, constraints, readOnly, subagentType/provider/model/modelHint, isolation, maxTokens, evidenceRefs, verification, outputSchema, terseResult.

The script must be deterministic capability-only JavaScript: no imports, process, filesystem, shell, network, timers, Date.now, Math.random, or direct effects. It must launch useful agents, use bounded concurrency/loops, and return JSON.

Request:
${request}

Scout evidence:
${scout}
${existing === undefined ? '' : `\nExisting capsule:\n${JSON.stringify(existing)}\nRequested change:\n${change ?? ''}`}

Return structured fields manifest/source/intent/inputs/requires. Manifest fields are name, description, phases, readOnly, optional plannedAgents, maxAgents, maxConcurrency, optional tokenBudget, optional mayUseWorktree, patterns, optional inputSchema. Allowed patterns: classify-and-act, fan-out-and-synthesize, adversarial-verification, generate-and-filter, tournament, loop-until-done.`
}

function smokeApi(): { readonly api: WorkflowApi; readonly artifactCount: () => number } {
  let sequence = 0
  const tasks = new Map<string, WorkflowTaskResult>()
  let artifacts = 0
  const assertAgentName = (name: unknown): string => {
    if (typeof name !== 'string' || name.trim().length === 0) throw new Error('workflow smoke agent name must be a non-empty string')
    return name
  }
  const assertEvidenceRefs = (refs: readonly string[] | undefined): void => {
    for (const ref of refs ?? []) {
      const prefix = ['file:', 'diff:', 'finding:', 'task_id:'].find(candidate => ref.startsWith(candidate))
      if (prefix === undefined || ref.slice(prefix.length).trim().length === 0) throw new Error(`workflow smoke evidence reference "${ref}" must use a non-empty file:, diff:, finding:, or task_id: reference`)
      if (prefix !== 'task_id:') continue
      const taskId = ref.slice(prefix.length).trim()
      if (tasks.has(taskId)) continue
      if ([...tasks.values()].some(task => task.name === taskId)) throw new Error(`workflow smoke evidence reference "${ref}" used an agent name, but task_id: requires the taskId returned by spawnAgent/runAgent`)
      throw new Error(`workflow smoke evidence reference "${ref}" references an unknown workflow task id`)
    }
  }
  const completed = (input: WorkflowSpawnAgentInput): WorkflowTaskResult => {
    const name = assertAgentName(input.name)
    assertEvidenceRefs(input.evidenceRefs)
    const taskId = `smoke-task-${++sequence}-${randomUUID().slice(0, 8)}`
    const result: WorkflowTaskResult = { taskId, name, status: 'completed', finalText: `Smoke result for ${name}: completed, done, verified.`, structured: {}, startedAt: 1, endedAt: 2 }
    tasks.set(taskId, result)
    return result
  }
  const known = (method: string, taskId: string): WorkflowTaskResult => {
    const result = tasks.get(taskId)
    if (result !== undefined) return result
    const named = [...tasks.values()].some(task => task.name === taskId)
    if (named) {
      throw new Error(`wf.${method}("${taskId}") used an agent name, but workflow task APIs require the taskId returned by spawnAgent/runAgent`)
    }
    throw new Error(`wf.${method}("${taskId}") references an unknown workflow task id`)
  }
  const snapshot = (method: string, taskId: string) => {
    const result = known(method, taskId)
    return { taskId: result.taskId, name: result.name, status: result.status, finalText: result.finalText, structured: result.structured, startedAt: result.startedAt, endedAt: result.endedAt }
  }
  const api: WorkflowApi = {
    runId: 'author-smoke', args: {}, budget: { total: null, spent: () => 0, remaining: () => Infinity },
    phase: async (_name, fn) => await fn(),
    spawnAgent: async input => {
      const result = completed(input)
      return { taskId: result.taskId, name: result.name }
    },
    runAgent: async input => completed(input),
    wait: async taskId => known('wait', taskId),
    snapshot: async taskId => snapshot('snapshot', taskId),
    output: async taskId => snapshot('output', taskId),
    send: async taskId => { known('send', taskId) },
    stop: async taskId => { known('stop', taskId) },
    parallel: async <T>(thunks: readonly (() => Promise<T>)[], options?: { readonly concurrency?: number }): Promise<(T | null)[]> => {
      const values: (T | null)[] = []
      for (const thunk of thunks) values.push(await thunk())
      void options
      return values
    },
    pipeline: async (items, ...stages) => await Promise.all(items.map(async (item, index) => { let value: unknown = item; for (const stage of stages) value = await stage(value, item, index); return value })),
    synthesize: async () => ({ text: 'smoke synthesis' }), workflow: async () => null,
    artifact: async name => { artifacts += 1; return { name, path: `/smoke/${name}.json` } }, log: () => {},
  }
  return { api, artifactCount: () => artifacts }
}

function isSmokeResultDisplayable(value: unknown, artifactCount: number): boolean {
  if (artifactCount > 0) return true
  if (typeof value === 'string') return value.trim().length > 0
  if (value === undefined || value === null) return false
  if (typeof value !== 'object') return true
  if (Array.isArray(value)) return value.length > 0
  const record = value as Record<string, unknown>
  let sawDisplayKey = false
  const synthesis = record.synthesis
  if (typeof synthesis === 'string') {
    sawDisplayKey = true
    if (synthesis.trim().length > 0) return true
  }
  if (synthesis !== null && typeof synthesis === 'object') {
    sawDisplayKey = true
    const synthesisText = (synthesis as Record<string, unknown>).text
    if (typeof synthesisText === 'string' && synthesisText.trim().length > 0) return true
  }
  for (const key of ['summary', 'report', 'text', 'result']) {
    const candidate = record[key]
    if (candidate !== undefined) sawDisplayKey = true
    if (typeof candidate === 'string' && candidate.trim().length > 0) return true
  }
  const displayKeys = new Set(['synthesis', 'summary', 'report', 'text', 'result'])
  if (sawDisplayKey && Object.keys(record).every(key => displayKeys.has(key))) return false
  return Object.keys(record).length > 0
}

async function smokeCapsule(capsule: WorkflowCapsule, config: ResolvedWorkflowConfig): Promise<void> {
  const findings = lintRestrictedWorkflowSource(capsule.source)
  const hard = findings.filter(item => ['NO_AGENT_WORK', 'UNBOUNDED_LOOP', 'UNOBSERVED_TASK', 'UNAWAITED_AGENT'].includes(item.code))
  if (hard.length > 0) throw new Error(hard.map(item => `${item.code}: ${item.message}`).join('; '))
  const literalLaunches = [...capsule.source.matchAll(/\bwf\.(?:runAgent|spawnAgent)\s*\(/gu)].length
  if (literalLaunches > capsule.manifest.maxAgents) throw new Error(`workflow source contains ${literalLaunches} static agent launches but manifest.maxAgents is ${capsule.manifest.maxAgents}`)
  const example = capsule.inputs?.examples?.[0] ?? {}
  const smoke = smokeApi()
  const result = await runRestrictedWorkflowScript({
    source: capsule.source, wf: smoke.api, args: example,
    filename: `${capsule.manifest.name}.author-smoke.js`,
    syncTimeoutMs: Math.min(config.scriptSyncTimeoutMs, 250), wallTimeoutMs: Math.min(config.scriptWallTimeoutMs, 1_000),
  })
  if (!isSmokeResultDisplayable(result, smoke.artifactCount())) throw new Error('run() returned no displayable result or artifact')
}

export async function authorWorkflowCapsule(input: {
  readonly request: string
  readonly parent: Agent
  readonly subagents: SubagentRuntime
  readonly config: ResolvedWorkflowConfig
  readonly signal: AbortSignal
  readonly existing?: WorkflowCapsule
  readonly change?: string
  readonly fromRunId?: string
}): Promise<{ readonly capsule: WorkflowCapsule; readonly warnings: readonly string[] }> {
  if (input.request.trim().length === 0) throw new Error('workflow authoring request must be non-empty')
  const scoutRoute = input.config.modelTiers.fast
  const authorRoute = input.config.modelTiers.deep
  const scout = await oneShot(
    input.subagents,
    scoutRoute,
    input.parent,
    `Scout the current workspace read-only for facts needed to design this reusable multi-agent workflow. Identify scope, available tools, risks, parallel seams, and verification needs. Do not implement it.\n\n${input.request}`,
    input.signal,
    input.config,
  )
  let priorError = ''
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const authored = await oneShot(
      input.subagents,
      authorRoute,
      input.parent,
      `${authorPrompt(input.request, scout.text, input.existing, input.change)}${priorError.length === 0 ? '' : `\n\nRepair this validation failure from the prior attempt:\n${priorError}`}`,
      input.signal,
      input.config,
      AUTHOR_SCHEMA,
    )
    try {
      if (authored.structured === undefined) throw new Error('workflow author returned no structured capsule payload')
      const payload = authored.structured as Record<string, unknown>
      const capsule = createWorkflowCapsule({
        minDshVersion: input.config.dshVersion,
        manifest: payload.manifest as WorkflowCapsule['manifest'],
        source: String(payload.source ?? ''),
        ...payload.intent === undefined ? {} : { intent: payload.intent as NonNullable<WorkflowCapsule['intent']> },
        ...payload.inputs === undefined ? {} : { inputs: payload.inputs as NonNullable<WorkflowCapsule['inputs']> },
        ...payload.requires === undefined ? {} : { requires: payload.requires as NonNullable<WorkflowCapsule['requires']> },
        provenance: {
          ...(input.fromRunId === undefined ? {} : { fromRunId: input.fromRunId }),
          ...(input.existing === undefined ? {} : { fromWorkflowName: input.existing.manifest.name, revisionOf: input.existing.manifest.name }),
          createdAt: new Date().toISOString(),
          dshVersion: input.config.dshVersion,
          pluginVersion: input.config.pluginVersion,
        },
      })
      validateWorkflowCapsule(capsule, input.config)
      validateRestrictedWorkflowSource(capsule.source, `${capsule.manifest.name}.workflow.js`)
      assertRestrictedWorkflowQuality(capsule.source)
      await smokeCapsule(capsule, input.config)
      return { capsule, warnings: lintRestrictedWorkflowSource(capsule.source).map(item => `${item.code}: ${item.message}`) }
    } catch (error) {
      priorError = error instanceof Error ? error.message : String(error)
      if (attempt === 3) throw new Error(`workflow author failed validation after ${attempt} attempts: ${priorError}`, { cause: error })
    }
  }
  throw new Error('workflow author exhausted its repair loop')
}
