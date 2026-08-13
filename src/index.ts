import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { createWorkflowCapsule, validateWorkflowArgs, validateWorkflowManifest } from './capsule.js'
import { smokeWorkflowCapsule } from './author.js'
import { scopedReviewWorkflow, writeReviewPackets } from './scoped-review.js'
import { DynamicWorkflowService } from './service.js'
import type { ModelTierRoute, ResolvedWorkflowConfig, WorkflowModule, WorkflowRun, WorkflowRunSnapshot } from './types.js'

export { DynamicWorkflowService } from './service.js'
export * from './types.js'
export * from './capsule.js'
export * from './catalog.js'
export * from './runtime.js'
export * from './source-policy.js'
export * from './store.js'
export * from './builtins.js'
export * from './author.js'
export * from './scoped-review.js'
export * from './engine.js'

export const name = 'dsh-external-workflow'
export const inject = ['subagents', 'tools']

export interface Config {
  readonly projectDirectory?: string
  readonly personalDirectory?: string
  readonly runDirectory?: string
  readonly listToolName?: string
  readonly runToolName?: string
  readonly manageToolName?: string
  readonly maxCapsuleBytes?: number
  readonly maxCatalogEntries?: number
  readonly maxAgents?: number
  readonly maxConcurrency?: number
  readonly maxResultChars?: number
  readonly scriptSyncTimeoutMs?: number
  readonly scriptWallTimeoutMs?: number
  readonly defaultProvider?: string
  readonly synthesisProvider?: string
  readonly fastProvider?: string
  readonly fastModelProvider?: string
  readonly fastModel?: string
  readonly fastMaxTokens?: number
  readonly balancedProvider?: string
  readonly balancedModelProvider?: string
  readonly balancedModel?: string
  readonly balancedMaxTokens?: number
  readonly deepProvider?: string
  readonly deepModelProvider?: string
  readonly deepModel?: string
  readonly deepMaxTokens?: number
  readonly readOnlyDeniedTools?: string[]
  readonly readOnlyAllowedTools?: string[]
  readonly approvalMode?: 'never' | 'generated-and-local' | 'always'
  readonly availableTools?: string[]
  readonly availableMcp?: string[]
  readonly availableSkills?: string[]
  readonly maxRetainedRuns?: number
}

export const Config: z<Config> = z.object({
  projectDirectory: z.string().default('.dsh/workflows'),
  personalDirectory: z.string().default('workflows'),
  runDirectory: z.string().default('.dsh/workflow-runs'),
  listToolName: z.string().default('workflow_list'),
  runToolName: z.string().default('run_workflow'),
  manageToolName: z.string().default('workflow_manage'),
  maxCapsuleBytes: z.natural().min(1).default(512_000),
  maxCatalogEntries: z.natural().min(1).default(200),
  maxAgents: z.natural().min(1).default(64),
  maxConcurrency: z.natural().min(1).default(8),
  maxResultChars: z.natural().min(1).default(50_000),
  scriptSyncTimeoutMs: z.natural().min(1).default(10_000),
  scriptWallTimeoutMs: z.natural().min(1).default(3_600_000),
  defaultProvider: z.string().default('spawn'),
  synthesisProvider: z.string().default('spawn'),
  fastProvider: z.string().default('spawn'),
  fastModelProvider: z.string().default(''),
  fastModel: z.string().default(''),
  fastMaxTokens: z.natural().min(1).default(4_096),
  balancedProvider: z.string().default('spawn'),
  balancedModelProvider: z.string().default(''),
  balancedModel: z.string().default(''),
  balancedMaxTokens: z.natural().min(1).default(8_192),
  deepProvider: z.string().default('spawn'),
  deepModelProvider: z.string().default(''),
  deepModel: z.string().default(''),
  deepMaxTokens: z.natural().min(1).default(16_384),
  readOnlyAllowedTools: z.array(z.string()).default(['read', 'read_image', 'glob', 'grep', 'lsp', 'skill', 'web_search']),
  readOnlyDeniedTools: z.array(z.string()).default([]),
  approvalMode: z.union(['never', 'generated-and-local', 'always'] as const).default('generated-and-local'),
  availableTools: z.array(z.string()).default([]),
  availableMcp: z.array(z.string()).default([]),
  availableSkills: z.array(z.string()).default([]),
  maxRetainedRuns: z.natural().min(1).default(500),
})

interface ResolvedPluginConfig extends ResolvedWorkflowConfig {
  readonly listToolName: string
  readonly runToolName: string
  readonly manageToolName: string
}

function tier(subagentProvider: string, provider: string, model: string, maxTokens: number): ModelTierRoute {
  return { subagentProvider, ...(provider.length === 0 ? {} : { provider }), ...(model.length === 0 ? {} : { model }), maxTokens }
}

function resolveConfig(config: Config): ResolvedPluginConfig {
  return {
    projectDirectory: config.projectDirectory ?? '.dsh/workflows',
    personalDirectory: config.personalDirectory ?? 'workflows',
    runDirectory: config.runDirectory ?? '.dsh/workflow-runs',
    listToolName: config.listToolName ?? 'workflow_list',
    runToolName: config.runToolName ?? 'run_workflow',
    manageToolName: config.manageToolName ?? 'workflow_manage',
    maxCapsuleBytes: config.maxCapsuleBytes ?? 512_000,
    maxCatalogEntries: config.maxCatalogEntries ?? 200,
    maxAgents: config.maxAgents ?? 64,
    maxConcurrency: config.maxConcurrency ?? 8,
    maxResultChars: config.maxResultChars ?? 50_000,
    scriptSyncTimeoutMs: config.scriptSyncTimeoutMs ?? 10_000,
    scriptWallTimeoutMs: config.scriptWallTimeoutMs ?? 3_600_000,
    defaultProvider: config.defaultProvider ?? 'spawn',
    synthesisProvider: config.synthesisProvider ?? 'spawn',
    modelTiers: {
      fast: tier(config.fastProvider ?? 'spawn', config.fastModelProvider ?? '', config.fastModel ?? '', config.fastMaxTokens ?? 4_096),
      balanced: tier(config.balancedProvider ?? 'spawn', config.balancedModelProvider ?? '', config.balancedModel ?? '', config.balancedMaxTokens ?? 8_192),
      deep: tier(config.deepProvider ?? 'spawn', config.deepModelProvider ?? '', config.deepModel ?? '', config.deepMaxTokens ?? 16_384),
    },
    readOnlyAllowedTools: [...(config.readOnlyAllowedTools ?? ['read', 'read_image', 'glob', 'grep', 'lsp', 'skill', 'web_search'])],
    readOnlyToolFilter: { deny: [...(config.readOnlyDeniedTools ?? [])] },
    approvalMode: config.approvalMode ?? 'generated-and-local',
    availableTools: [...(config.availableTools ?? [])],
    availableMcp: [...(config.availableMcp ?? [])],
    availableSkills: [...(config.availableSkills ?? [])],
    maxRetainedRuns: config.maxRetainedRuns ?? 500,
    pluginVersion: '0.1.2',
    dshVersion: '0.0.1-rc.2',
  }
}

function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('workflow operation requires a calling DSH agent')
  return agent
}

function render(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function publicSnapshot(snapshot: WorkflowRunSnapshot): unknown {
  return JSON.parse(JSON.stringify(snapshot))
}

async function runResult(service: DynamicWorkflowService, agent: Agent, run: WorkflowRun, wait: boolean): Promise<unknown> {
  if (!wait) {
    const jobId = service.attachBackgroundJob(agent, run)
    return { runId: run.runId, status: run.getSnapshot().status, ...(jobId === undefined ? {} : { jobId }) }
  }
  return publicSnapshot(await run.done)
}

function inlineModule(source: string, manifest: unknown, resolved: ResolvedWorkflowConfig): WorkflowModule {
  const normalized = validateWorkflowManifest(manifest, resolved)
  const capsule = createWorkflowCapsule({
    minDshVersion: resolved.dshVersion,
    manifest: normalized,
    source,
    provenance: { createdAt: new Date().toISOString(), dshVersion: resolved.dshVersion, pluginVersion: resolved.pluginVersion },
  })
  return { manifest: normalized, execution: 'capability-generated', source, capsule }
}

function parseJsonOrText(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed) as unknown } catch { return { question: trimmed } }
  }
  return { question: trimmed }
}

type WorkflowHandoffGrants = WeakMap<Agent, string>

function handoffWorkflowRequest(agent: Agent, request: string, grants: WorkflowHandoffGrants): CommandResult {
  const trimmed = request.trim()
  if (trimmed.length === 0) throw new Error('create requires a workflow request')
  if (/(?:^|\s)--wait(?:\s|$)/u.test(trimmed)) {
    throw new Error('--wait is not supported for /workflow create or free-text requests; the current Agent owns authoring and reports progress in its turn')
  }
  agent.inject(createUserMessage({
    content: [{
      type: 'text',
      text: [
        'Set up and run a multi-agent workflow for this task.',
        `First investigate the relevant files and sub-problems with your own tools, then author and run it with run_workflow using source + manifest (not request mode). Bake concrete findings such as exact paths, comparison dimensions, constraints, and a real outputSchema into the child prompts instead of re-delegating the scouting.`,
        'Authoring contract (you do not need to search for it): source is JavaScript defining async function run(wf, args). Use wf.phase(name, fn), wf.runAgent({ name, prompt, readOnly, modelHint, outputSchema? }), wf.parallel(thunks, { concurrency }), and wf.synthesize({ inputs, rubric }). modelHint, when present, must be exactly fast, balanced, or deep. Return the final value from run.',
        'The manifest is JSON with exactly: name (lowercase kebab-case), description, phases (non-empty string array matching source phases), readOnly, maxAgents, maxConcurrency, and patterns. patterns entries must be one or more of classify-and-act, fan-out-and-synthesize, adversarial-verification, generate-and-filter, tournament, loop-until-done. Optional fields: plannedAgents, tokenBudget, mayUseWorktree, inputSchema.',
        `Minimal example: source \`async function run(wf,args){return await wf.phase("analyze",async()=>{const r=await wf.runAgent({name:"analyst",prompt:String(args?.request??"analyze the task"),readOnly:true,modelHint:"balanced"});return r?.finalText??"no result"})}\` with manifest \`{"name":"focused-analysis","description":"Analyze with one specialist.","phases":["analyze"],"readOnly":true,"maxAgents":1,"maxConcurrency":1,"patterns":["classify-and-act"]}\`. Adapt it to the user's task and pass the original request via args.`,
      ].join('\n'),
    }],
    source: { kind: 'plugin', plugin: '@dsh-external/workflow', form: 'relay' },
  }))
  const message = createUserMessage({
    content: [{ type: 'text', text: trimmed }],
    source: { kind: 'user' },
  })
  grants.set(agent, String(message.id))
  agent.steer(message)
  return { kind: 'success', text: 'Workflow request handed to the current agent.' }
}

function hasCurrentWorkflowHandoff(agent: Agent, grants: WorkflowHandoffGrants): boolean {
  const expectedMessageId = grants.get(agent)
  if (expectedMessageId === undefined) return false
  const events = agent.session.events ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'turn/start' || event.type === 'turn/end') return false
    if (event.type !== 'user/message') continue
    const source = event.data.source
    if (String(event.data.id) === expectedMessageId) {
      return source.kind === 'user'
    }
    if (source.kind === 'user') return false
  }
  return false
}

function consumeCurrentWorkflowHandoff(agent: Agent, grants: WorkflowHandoffGrants): boolean {
  if (!hasCurrentWorkflowHandoff(agent, grants)) return false
  grants.delete(agent)
  return true
}

function optionTokens(raw: string): string[] {
  return raw.trim().length === 0 ? [] : raw.trim().split(/\s+/u)
}

function nonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function runsLimit(raw: string): number | undefined {
  const args = optionTokens(raw)
  let limit = 20
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--all') { limit = Number.MAX_SAFE_INTEGER; continue }
    if (args[index] === '--limit') {
      const parsed = nonNegativeInteger(args[index + 1])
      if (parsed === undefined || parsed < 1) throw new Error('--limit expects a positive integer')
      limit = Math.min(parsed, 200)
      index += 1
      continue
    }
    throw new Error(`unknown option: ${args[index]}`)
  }
  return limit
}

function pruneOptions(raw: string): { readonly keep?: number; readonly olderThanMs?: number; readonly dryRun: boolean } {
  const args = optionTokens(raw)
  let keep: number | undefined
  let olderThanMs: number | undefined
  let dryRun = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--dry-run') { dryRun = true; continue }
    if (arg === '--keep') {
      const parsed = nonNegativeInteger(args[index + 1])
      if (parsed === undefined) throw new Error('--keep expects a non-negative integer')
      keep = parsed; index += 1; continue
    }
    if (arg === '--older-than') {
      const match = /^(\d+)([dh]?)$/iu.exec(args[index + 1] ?? '')
      const amount = match === null ? undefined : nonNegativeInteger(match[1])
      if (amount === undefined || amount <= 0) throw new Error('--older-than expects a value like 7d or 24h')
      olderThanMs = amount * (match?.[2]?.toLowerCase() === 'h' ? 3_600_000 : 86_400_000)
      index += 1; continue
    }
    throw new Error(`unknown option: ${arg}`)
  }
  if (dryRun && keep === undefined && olderThanMs === undefined) keep = 50
  return { ...(keep === undefined ? {} : { keep }), ...(olderThanMs === undefined ? {} : { olderThanMs }), dryRun }
}

function splitFirst(raw: string): { readonly head: string; readonly tail: string } {
  const trimmed = raw.trim()
  const boundary = trimmed.search(/\s/u)
  return boundary < 0 ? { head: trimmed, tail: '' } : { head: trimmed.slice(0, boundary), tail: trimmed.slice(boundary).trim() }
}

const execFileAsync = promisify(execFile)

interface CapturedReviewDiff {
  readonly diff: string
  readonly label: string
  readonly scope: 'all' | 'compare' | 'commit'
  readonly baseRef?: string
  readonly headRef?: string
}

interface WorkflowReviewInvocation {
  readonly lean: boolean
  readonly wait: boolean
  readonly routingRisk?: 'low' | 'medium' | 'high'
  readonly diffArgs: readonly string[]
  readonly requirements: readonly string[]
  readonly testEvidence: readonly string[]
  readonly prompt?: string
}

function commandWords(raw: string): readonly string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else if (character === '\\' && quote === '"' && raw[index + 1] === '"') current += raw[++index]!
      else current += character
    } else if (character === '"' || character === "'") quote = character
    else if (/\s/u.test(character)) {
      if (current.length > 0) { words.push(current); current = '' }
    } else current += character
  }
  if (quote !== undefined) throw new Error('review command contains an unterminated quote')
  if (current.length > 0) words.push(current)
  return words
}

function parseWorkflowReview(raw: string): WorkflowReviewInvocation {
  const args = commandWords(raw)
  let lean = false
  let wait = false
  let routingRisk: 'low' | 'medium' | 'high' | undefined
  let scopeConsumed = false
  let promptMode = false
  const diffArgs: string[] = []
  const requirements: string[] = []
  const testEvidence: string[] = []
  const prompt: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (promptMode) { prompt.push(arg); continue }
    if (arg === '--') { promptMode = true; continue }
    if (arg === '--lean') { lean = true; continue }
    if (arg === '--wait') { wait = true; continue }
    if (arg === '--risk') {
      const risk = args[++index]
      if (risk !== 'low' && risk !== 'medium' && risk !== 'high') throw new Error('review --risk requires low, medium, or high')
      routingRisk = risk
      continue
    }
    if (arg.startsWith('--risk=')) {
      const risk = arg.slice('--risk='.length)
      if (risk !== 'low' && risk !== 'medium' && risk !== 'high') throw new Error('review --risk requires low, medium, or high')
      routingRisk = risk
      continue
    }
    if (arg === '--requirement' || arg === '--requirements' || arg === '--test-evidence') {
      const evidence = args[++index]
      if (evidence === undefined || evidence.trim().length === 0) throw new Error(`review ${arg} requires a value (quote multi-word values)`)
      ;(arg === '--test-evidence' ? testEvidence : requirements).push(evidence)
      continue
    }
    if (!scopeConsumed && arg === 'base') { diffArgs.push(arg); scopeConsumed = true; continue }
    if (!scopeConsumed && arg === 'sha') {
      diffArgs.push(arg)
      scopeConsumed = true
      let commit: string | undefined
      while (index + 1 < args.length) {
        const next = args[index + 1]!
        if (next === '--lean') { lean = true; index += 1; continue }
        if (next === '--wait') { wait = true; index += 1; continue }
        if (next.startsWith('--')) break
        commit = next
        index += 1
        break
      }
      if (commit === undefined) throw new Error('review sha requires a commit hash')
      diffArgs.push(commit)
      continue
    }
    prompt.push(arg)
  }
  const focus = prompt.join(' ').trim()
  return { lean, wait, ...(routingRisk === undefined ? {} : { routingRisk }), diffArgs, requirements, testEvidence, ...(focus.length === 0 ? {} : { prompt: focus }) }
}

async function reviewGit(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  return stdout
}

async function resolveReviewRef(ref: string, cwd: string): Promise<string> {
  return (await reviewGit(['rev-parse', ref], cwd)).trim()
}

async function detectReviewBase(cwd: string): Promise<string> {
  for (const branch of ['main', 'master', 'develop']) {
    try { await reviewGit(['rev-parse', '--verify', branch], cwd); return branch } catch { /* try next conventional base */ }
  }
  return 'HEAD'
}

async function captureReviewDiff(args: readonly string[], cwd: string): Promise<CapturedReviewDiff> {
  if (args[0] === 'base') {
    const base = await detectReviewBase(cwd)
    return { diff: await reviewGit(['diff', `${base}...HEAD`], cwd), label: `changes against ${base}`, scope: 'compare', baseRef: await resolveReviewRef(base, cwd), headRef: await resolveReviewRef('HEAD', cwd) }
  }
  if (args[0] === 'sha') {
    const commit = args[1]
    if (commit === undefined) throw new Error('review sha requires a commit hash')
    let baseRef: string | undefined
    try { baseRef = await resolveReviewRef(`${commit}^`, cwd) } catch { /* root commits have no parent */ }
    return { diff: await reviewGit(['show', commit], cwd), label: `commit ${commit}`, scope: 'commit', ...(baseRef === undefined ? {} : { baseRef }), headRef: await resolveReviewRef(commit, cwd) }
  }
  return { diff: await reviewGit(['diff', 'HEAD'], cwd), label: 'uncommitted changes', scope: 'all', headRef: await resolveReviewRef('HEAD', cwd) }
}

const HELP = `/workflow - reusable, governed multi-agent workflows
  /workflow list
  /workflow create <request>
  /workflow review [base | sha <hash>] [--lean] [--risk high] [--requirement "..."] [--test-evidence "..."] [--wait] [-- <focus>]
  /workflow <name> [JSON args]
  /workflow runs [--all|--limit N]
  /workflow show [--full] [runId]
  /workflow pause|resume|stop [runId]
  /workflow rerun|resume-run <runId|savedName> [JSON args] [--wait]
  /workflow save <runId> <name> [project|personal]
  /workflow rename-run <runId> <display name>
  /workflow rename-saved <from> <to> [project|personal]
  /workflow revise <savedName> <change>
  /workflow delete-run <runId> [--force]
  /workflow delete-saved <name> [project|personal]
  /workflow delete [--force] [--run|--saved] <runId|savedName>
  /workflow rename <runId|alias|savedName> <newName>
  /workflow revise [--replace] <runId|alias|savedName> <change>
  /workflow prune [--dry-run] [--keep N] [--older-than 7d|24h]`

async function command(service: DynamicWorkflowService, agent: Agent, raw: string, signal: AbortSignal, grants: WorkflowHandoffGrants): Promise<CommandResult> {
  try {
    const { head, tail } = splitFirst(raw)
    if (head === '' || head === 'list') return { kind: 'success', text: JSON.stringify(await service.list(agent), null, 2) }
    if (head === 'help') return { kind: 'success', text: HELP }
    if (head === 'review') {
      const invocation = parseWorkflowReview(tail)
      const cwd = agent.session.header.cwd ?? process.cwd()
      const captured = await captureReviewDiff(invocation.diffArgs, cwd)
      if (captured.diff.trim().length === 0) return { kind: 'success', text: 'No changes to review.' }
      const packets = await writeReviewPackets({
        cwd, sessionId: String(agent.session.id), label: captured.label, diff: captured.diff, scope: captured.scope,
        ...(captured.baseRef === undefined ? {} : { baseRef: captured.baseRef }), ...(captured.headRef === undefined ? {} : { headRef: captured.headRef }),
        ...(invocation.prompt === undefined ? {} : { customPrompt: invocation.prompt }), requirements: invocation.requirements,
        testEvidence: invocation.testEvidence, ...(invocation.routingRisk === undefined ? {} : { routingRisk: invocation.routingRisk }),
      })
      const run = await service.startInline(agent, scopedReviewWorkflow, {
        packets, ...(invocation.lean ? { lean: true } : {}), ...(invocation.prompt === undefined ? {} : { reviewFocus: invocation.prompt }),
      }, signal, 'built-in', true)
      return { kind: 'success', text: JSON.stringify(await runResult(service, agent, run, invocation.wait), null, 2) }
    }
    if (head === 'runs') return { kind: 'success', text: JSON.stringify(service.runs(agent).slice(0, runsLimit(tail)), null, 2) }
    if (head === 'show') {
      const full = tail.split(/\s+/u).includes('--full')
      const target = tail.split(/\s+/u).find(token => !token.startsWith('--')) ?? service.runs(agent)[0]?.runId ?? ''
      const snapshot = service.show(agent, target)
      if (snapshot === undefined) return { kind: 'success', text: JSON.stringify({ error: 'run not found' }, null, 2) }
      const events = service.events(agent, target)
      const value = full ? { ...snapshot, events } : {
        runId: snapshot.runId, workflow: snapshot.workflow, displayName: snapshot.displayName, status: snapshot.status,
        startedAt: snapshot.startedAt, endedAt: snapshot.endedAt, phase: snapshot.phase, resultSummary: snapshot.resultSummary,
        error: snapshot.error, process: snapshot.process, cost: snapshot.cost, artifacts: snapshot.artifacts, events,
      }
      return { kind: 'success', text: JSON.stringify(value, null, 2) }
    }
    if (head === 'pause' || head === 'resume' || head === 'stop') {
      const target = tail || (service.runs(agent).find(run => run.status === 'running' || run.status === 'paused')?.runId ?? '')
      const ok = head === 'pause' ? service.pause(agent, target) : head === 'resume' ? service.resume(agent, target) : service.stop(agent, target)
      return ok ? { kind: 'success', text: `${head} accepted for ${target}` } : { kind: 'error', text: `${head} is unavailable for ${target}` }
    }
    if (head === 'create') {
      return handoffWorkflowRequest(agent, tail, grants)
    }
    if (head === 'rerun' || head === 'resume-run') {
      const wantsWait = /(?:^|\s)--wait(?:\s|$)/u.test(tail)
      const target = splitFirst(tail.replace(/(?:^|\s)--wait(?:\s|$)/gu, ' ').trim())
      if (target.head.length === 0) throw new Error(`${head} requires a run id or saved workflow name`)
      const approved = await service.confirm(agent, `${head === 'resume-run' ? 'Resume' : 'Rerun'} workflow "${target.head}"?`, 'The workflow may start multiple DSH child agents. Normal permission gates still apply.', signal)
      if (!approved) return { kind: 'error', text: 'workflow cancelled' }
      const run = await service.rerun(agent, target.head, parseJsonOrText(target.tail), signal, head === 'resume-run', true)
      return { kind: 'success', text: JSON.stringify(await runResult(service, agent, run, wantsWait), null, 2) }
    }
    if (head === 'save') {
      const first = splitFirst(tail); const second = splitFirst(first.tail)
      return { kind: 'success', text: await service.saveRun(agent, first.head, second.head, second.tail === 'personal' ? 'personal' : 'project') }
    }
    if (head === 'delete') {
      const force = /(?:^|\s)--force(?:\s|$)/u.test(tail)
      const runOnly = /(?:^|\s)--run(?:\s|$)/u.test(tail)
      const savedOnly = /(?:^|\s)--saved(?:\s|$)/u.test(tail)
      if (runOnly && savedOnly) throw new Error('delete accepts only one of --run or --saved')
      const target = tail.split(/\s+/u).find(token => !token.startsWith('--')) ?? ''
      if (target.length === 0) throw new Error('delete requires a run id or saved workflow name')
      const runMatch = service.show(agent, target)
      const savedMatch = (await service.list(agent)).entries.find(entry => entry.name === target && (entry.source === 'project' || entry.source === 'personal'))
      if (!runOnly && !savedOnly && runMatch !== undefined && savedMatch !== undefined) throw new Error(`workflow target "${target}" is ambiguous; add --run or --saved`)
      if (runOnly || (!savedOnly && runMatch !== undefined)) service.deleteRun(agent, target, force)
      else if (savedMatch !== undefined) await service.deleteSaved(agent, target, savedMatch.source === 'personal' ? 'personal' : 'project')
      else throw new Error(`workflow target "${target}" was not found`)
      return { kind: 'success', text: `deleted ${target}` }
    }
    if (head === 'rename') {
      const parsed = splitFirst(tail)
      if (parsed.head.length === 0 || parsed.tail.length === 0) throw new Error('rename requires a target and new name')
      const runMatch = service.show(agent, parsed.head)
      const savedMatch = (await service.list(agent)).entries.find(entry => entry.name === parsed.head && (entry.source === 'project' || entry.source === 'personal'))
      if (runMatch !== undefined && savedMatch !== undefined) throw new Error(`workflow target "${parsed.head}" is ambiguous`)
      if (runMatch !== undefined) return { kind: 'success', text: JSON.stringify(service.renameRun(agent, parsed.head, parsed.tail), null, 2) }
      if (savedMatch !== undefined) return { kind: 'success', text: await service.renameSaved(agent, parsed.head, parsed.tail, savedMatch.source === 'personal' ? 'personal' : 'project') }
      throw new Error(`workflow target "${parsed.head}" was not found`)
    }
    if (head === 'rename-run') {
      const target = splitFirst(tail)
      return { kind: 'success', text: JSON.stringify(service.renameRun(agent, target.head, target.tail), null, 2) }
    }
    if (head === 'rename-saved') {
      const from = splitFirst(tail); const to = splitFirst(from.tail)
      return { kind: 'success', text: await service.renameSaved(agent, from.head, to.head, to.tail === 'personal' ? 'personal' : 'project') }
    }
    if (head === 'revise') {
      const replace = /(?:^|\s)--replace(?:\s|$)/u.test(tail)
      const target = splitFirst(tail.replace(/(?:^|\s)--replace(?:\s|$)/gu, ' ').trim())
      const revised = await service.revise(agent, target.head, target.tail, signal, replace)
      return { kind: 'success', text: JSON.stringify(revised, null, 2) }
    }
    if (head === 'delete-run') {
      const target = splitFirst(tail); service.deleteRun(agent, target.head, target.tail === '--force')
      return { kind: 'success', text: `deleted run ${target.head}` }
    }
    if (head === 'delete-saved') {
      const target = splitFirst(tail); await service.deleteSaved(agent, target.head, target.tail === 'personal' ? 'personal' : 'project')
      return { kind: 'success', text: `deleted saved workflow ${target.head}` }
    }
    if (head === 'prune') {
      return { kind: 'success', text: JSON.stringify(service.prune(agent, pruneOptions(tail)), null, 2) }
    }
    const entry = (await service.list(agent)).entries.find(item => item.name === head)
    if (entry !== undefined) {
      if (!entry.valid) throw new Error(entry.error ?? `workflow "${head}" is invalid`)
      const approved = await service.confirm(agent, `Run workflow "${head}"?`, 'The workflow may start multiple DSH child agents. Normal permission gates still apply.', signal)
      if (!approved) return { kind: 'error', text: 'workflow cancelled' }
      const wantsWait = /(?:^|\s)--wait(?:\s|$)/u.test(tail)
      const argsText = tail.replace(/(?:^|\s)--wait(?:\s|$)/gu, ' ').trim()
      const run = await service.startNamed(agent, head, parseJsonOrText(argsText), signal, true)
      return { kind: 'success', text: JSON.stringify(await runResult(service, agent, run, wantsWait), null, 2) }
    }
    return handoffWorkflowRequest(agent, raw, grants)
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

function installSurfaces(ctx: Context, resolved: ResolvedPluginConfig): void {
  const service = ctx.dynamicWorkflows
  const workflowHandoffGrants: WorkflowHandoffGrants = new WeakMap()

  ctx.tools.register(defineTool({
    name: resolved.listToolName,
    description: 'List built-in, pattern, project, and personal workflows. Invalid saved entries are reported without execution.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => render(value) },
    async execute(_args, exec) { return JSON.parse(JSON.stringify(await service.list(requireAgent(exec.agent)))) as never },
  }))

  ctx.tools.register(defineTool({
    name: resolved.runToolName,
    description: 'Run a named workflow, scout then author a new reusable workflow from a request, or execute a capability-only inline workflow. Returns a durable run process; set background for DSH job controls.',
    parameters: {
      name: { type: 'string', description: 'Saved, built-in, or pattern workflow name.' },
      request: { type: 'string', description: 'Task request for scout-then-author workflow generation.' },
      source: { type: 'string', description: 'Capability-only JavaScript defining async function run(wf, args).' },
      manifest: { type: 'json', description: 'Strict workflow manifest for inline source.' },
      args: { type: 'json', description: 'JSON arguments supplied to the workflow.' },
      wait: { type: 'boolean', description: 'Wait for the terminal outcome. Default false: return the durable process immediately.' },
      background: { type: 'boolean', description: 'Deprecated compatibility flag. false is equivalent to wait=true.' },
      save_scope: { type: 'string', enum: ['project', 'personal'], description: 'Save an authored request workflow before running it.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => render(value) },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      const selected = [args.name, args.request, args.source].filter(value => value !== undefined)
      if (selected.length !== 1) throw new Error('run_workflow requires exactly one of name, request, or source')
      const currentHandoff = hasCurrentWorkflowHandoff(agent, workflowHandoffGrants)
      if (currentHandoff && args.request !== undefined) {
        throw new Error('a /workflow command handoff must author inline source + manifest in the current Agent; request mode would start a second scout/author pipeline')
      }
      let run: WorkflowRun
      if (args.name !== undefined) run = await service.startNamed(agent, args.name, args.args, exec.signal)
      else if (args.request !== undefined) {
        const authored = await service.create(agent, args.request, exec.signal, args.save_scope === undefined ? undefined : { scope: args.save_scope })
        run = await service.startInline(agent, { manifest: authored.capsule.manifest, execution: 'capability-generated', source: authored.capsule.source, capsule: authored.capsule }, args.args, exec.signal, 'inline', false)
      } else {
        if (args.manifest === undefined) throw new Error('inline workflow source requires manifest')
        const module = inlineModule(args.source!, args.manifest, resolved)
        if (currentHandoff && module.capsule !== undefined) {
          validateWorkflowArgs(module.capsule, args.args === undefined ? {} : args.args)
          await smokeWorkflowCapsule(module.capsule, resolved, args.args, service.taskAdmissionServices(agent))
        }
        const explicitIntent = consumeCurrentWorkflowHandoff(agent, workflowHandoffGrants) && resolved.approvalMode !== 'always'
        run = await service.startInline(agent, module, args.args, exec.signal, 'inline', explicitIntent)
      }
      return await runResult(service, agent, run, args.wait === true || args.background === false) as never
    },
  }))

  ctx.tools.register(defineTool({
    name: resolved.manageToolName,
    description: 'Inspect and control durable workflow processes: runs/show/pause/resume/stop/rerun/resume-run/save/rename-run/rename-saved/revise/delete-run/delete-saved/prune.',
    parameters: {
      action: { type: 'string', required: true, enum: ['runs', 'show', 'pause', 'resume', 'stop', 'rerun', 'resume-run', 'save', 'rename-run', 'rename-saved', 'revise', 'delete-run', 'delete-saved', 'prune'] },
      target: { type: 'string' }, name: { type: 'string' }, value: { type: 'string' }, args: { type: 'json' }, wait: { type: 'boolean' },
      scope: { type: 'string', enum: ['project', 'personal'] }, force: { type: 'boolean' }, dry_run: { type: 'boolean' }, keep: { type: 'integer' }, older_than_days: { type: 'integer' }, background: { type: 'boolean' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => render(value) },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent)
      const target = args.target ?? ''
      switch (args.action) {
        case 'runs': return JSON.parse(JSON.stringify(service.runs(agent))) as never
        case 'show': return JSON.parse(JSON.stringify(service.show(agent, target) ?? null)) as never
        case 'pause': return { accepted: service.pause(agent, target) } as never
        case 'resume': return { accepted: service.resume(agent, target) } as never
        case 'stop': return { accepted: service.stop(agent, target, args.value) } as never
        case 'rerun':
        case 'resume-run': {
          const run = await service.rerun(agent, target, args.args, exec.signal, args.action === 'resume-run')
          return await runResult(service, agent, run, args.wait === true || args.background === false) as never
        }
        case 'save': return { path: await service.saveRun(agent, target, args.name ?? '', args.scope ?? 'project', args.force === true) } as never
        case 'rename-run': return JSON.parse(JSON.stringify(service.renameRun(agent, target, args.value ?? ''))) as never
        case 'rename-saved': return { path: await service.renameSaved(agent, target, args.name ?? '', args.scope ?? 'project') } as never
        case 'revise': return JSON.parse(JSON.stringify(await service.revise(agent, target, args.value ?? '', exec.signal, args.force === true))) as never
        case 'delete-run': service.deleteRun(agent, target, args.force === true); return { deleted: target } as never
        case 'delete-saved': await service.deleteSaved(agent, target, args.scope ?? 'project'); return { deleted: target } as never
        case 'prune': return JSON.parse(JSON.stringify(service.prune(agent, { ...(args.keep === undefined ? {} : { keep: args.keep }), ...(args.older_than_days === undefined ? {} : { olderThanMs: args.older_than_days * 86_400_000 }), dryRun: args.dry_run === true }))) as never
      }
    },
  }))

  ctx.inject(['systemPrompt'], child => {
    child.systemPrompt.section({
      name: 'tool:dynamic-workflows', order: 116,
      text: `Use ${resolved.runToolName} only when the user explicitly requests a workflow or the work materially benefits from reusable multi-agent orchestration. Prefer a named workflow when one matches. For a workflow relay from @dsh-external/workflow, scout with the current Agent's tools and call ${resolved.runToolName} with source + manifest; do not use request mode. Outside a command handoff, request mode can author a new reusable process. Use ${resolved.manageToolName} for lifecycle and durable results. Child effects remain subject to DSH tool visibility, sandbox, and approval policy.`,
    })
  })
  ctx.inject(['commands'], child => {
    child.commands.register({
      name: 'workflow', description: 'Create, run, inspect, and manage dynamic multi-agent workflows.',
      input: { hint: '[help|list|create|runs|show|pause|resume|stop|rerun|save|rename|revise|delete|prune|name] ...' },
      handler: invocation => command(service, invocation.agent, invocation.rawInput, invocation.signal, workflowHandoffGrants),
    })
  })
}

export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const approval = ctx.get('approval') as ApprovalService | undefined
  const jobs = ctx.get('jobs') as JobRegistry | undefined
  const userQuestions = ctx.get('userQuestions') as UserQuestionService | undefined
  ctx.plugin(DynamicWorkflowService, {
    config: resolved,
    subagents: ctx.subagents,
    ...(approval === undefined ? {} : { approval }),
    ...(jobs === undefined ? {} : { jobs }),
    ...(userQuestions === undefined ? {} : { userQuestions }),
  })
  ctx.inject(['dynamicWorkflows'], child => installSurfaces(child, resolved))
}

export default { name, inject, Config, apply }
