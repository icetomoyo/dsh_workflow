import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { SubagentRun, SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type { ToolWorkflowRunStartData } from '@deepseek-ai/dsh-tool-workflow/types'
import { assertObjectJsonSchema, validateJsonSchemaValue, type ObjectJsonSchema, type ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { createWorkflowCapsule, validateWorkflowArgs } from './capsule.js'
import { runRestrictedWorkflowScript, snapshotWorkflowJson } from './runtime.js'
import { WorkflowRunStore, type WorkflowRunWriter } from './store.js'
import type {
  JsonValue, ResolvedWorkflowConfig, WorkflowApi, WorkflowArtifactRef, WorkflowCapsule,
  WorkflowCostReport, WorkflowEvent, WorkflowModelHint, WorkflowPreflightResult, WorkflowRun,
  WorkflowManifest, WorkflowRunSnapshot, WorkflowSpawnAgentInput, WorkflowStartInput, WorkflowTaskHandle,
  WorkflowTaskResult, WorkflowTaskSnapshot, WorkflowTaskUsage, WorkflowVerificationAdapter, WorktreeIsolationAdapter,
  WorkflowDispatchAdapter, WorkflowDispatchTelemetry, WorkflowOutcome, WorkflowProcessItem, WorkflowProcessItemStatus, WorkflowProcessSnapshot, WorkflowTaskVerificationResult,
} from './types.js'
import { WORKFLOW_INTERNAL } from './types.js'

const execFileAsync = promisify(execFile)
const TERMINAL = new Set(['completed', 'failed', 'denied', 'stopped'])

interface TrackedTask {
  readonly id: string
  readonly sequence: number
  readonly input: WorkflowSpawnAgentInput
  readonly startedAt: number
  status: WorkflowTaskSnapshot['status']
  childId?: string
  run?: SubagentRun
  result?: WorkflowTaskResult
  promise: Promise<WorkflowTaskResult>
  resolve: (value: WorkflowTaskResult) => void
  reject: (error: unknown) => void
  ready: Promise<void>
  resolveReady: () => void
  rejectReady: (error: unknown) => void
  nativeStarted: boolean
  terminalPublished: boolean
  preflightWarnings?: readonly string[]
  origin?: 'executed' | 'replayed-from-cache'
  phase?: string
}

function isDispatchEnvelope(value: SubagentRun | { readonly run: SubagentRun; readonly telemetry?: WorkflowDispatchTelemetry | Promise<WorkflowDispatchTelemetry> }): value is { readonly run: SubagentRun; readonly telemetry?: WorkflowDispatchTelemetry | Promise<WorkflowDispatchTelemetry> } {
  return 'run' in value
}

interface MutableRun {
  snapshot: WorkflowRunSnapshot
  readonly input: WorkflowStartInput
  readonly controller: AbortController
  readonly writer: WorkflowRunWriter
  readonly tasks: Map<string, TrackedTask>
  readonly pauseWaiters: Set<() => void>
  readonly cacheOccurrences: Map<string, number>
  active: number
  peakConcurrency: number
  reservedTokens: number
  spentTokens: number
  taskSequence: number
  readonly nestingDepth: number
  nativeSession: Session
  completion?: Promise<WorkflowRunSnapshot>
}

export interface WorkflowEngineDependencies {
  readonly subagents: SubagentRuntime
  readonly config: ResolvedWorkflowConfig
  readonly store: WorkflowRunStore
  readonly approval?: ApprovalService
  readonly userInteractionAvailable?: boolean
  readonly verification?: WorkflowVerificationAdapter
  readonly isolation?: WorktreeIsolationAdapter
  readonly dispatch?: WorkflowDispatchAdapter
  readonly deploymentSemaphore?: WorkflowSemaphore
  readonly now?: () => number
  readonly id?: () => string
  readonly resolveNested: (name: string) => Promise<{ readonly module: WorkflowStartInput['module']; readonly source: WorkflowStartInput['source'] }>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class WorkflowControlError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkflowControlError'
  }
}

function isControlError(error: unknown): error is WorkflowControlError {
  return error instanceof WorkflowControlError
}

function cwdOf(agent: Agent): string {
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new Error('workflow requires a parent session with an absolute cwd')
  return cwd
}

function textOf(run: Awaited<SubagentRun['result']>): string {
  return run.output.filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n')
}

function usageOf(agent: Agent | undefined): WorkflowTaskUsage | undefined {
  if (agent === undefined) return undefined
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let observed = false
  for (const event of agent.session.events) {
    if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
    observed = true
    inputTokens += event.data.usage.inputTokens
    outputTokens += event.data.usage.outputTokens
    cacheReadTokens += event.data.usage.cacheReadTokens ?? 0
  }
  return observed ? { inputTokens, outputTokens, cacheReadTokens, totalTokens: inputTokens + outputTokens + cacheReadTokens } : undefined
}

function addUsage(left: WorkflowTaskUsage | undefined, right: WorkflowTaskUsage | undefined): WorkflowTaskUsage | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return {
    inputTokens: (left.inputTokens ?? 0) + (right.inputTokens ?? 0),
    outputTokens: (left.outputTokens ?? 0) + (right.outputTokens ?? 0),
    cacheReadTokens: (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0),
    totalTokens: left.totalTokens + right.totalTokens,
  }
}

function firstBalancedJson(text: string): string | undefined {
  const starts = [text.indexOf('{'), text.indexOf('[')].filter(index => index >= 0)
  if (starts.length === 0) return undefined
  const start = Math.min(...starts)
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') { quoted = true; continue }
    if (character === open) depth += 1
    if (character === close && --depth === 0) return text.slice(start, index + 1)
  }
  return undefined
}

function structuredEvaluation(structured: unknown, text: string, schema: ObjectJsonSchema): { readonly value?: unknown; readonly errors: readonly string[] } {
  if (structured !== undefined) {
    const errors = validateJsonSchemaValue(schema, structured)
    if (errors.length === 0) return { value: structured, errors: [] }
  }
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)].at(-1)?.[1]?.trim()
  const candidate = firstBalancedJson(fenced ?? text)
  if (candidate === undefined) return { errors: ['no JSON value was found in the output'] }
  try {
    const value = JSON.parse(candidate) as unknown
    const errors = validateJsonSchemaValue(schema, value)
    return errors.length === 0 ? { value, errors: [] } : { errors }
  } catch (error) {
    return { errors: [`output was not valid JSON: ${message(error)}`] }
  }
}

function jsonData(value: Record<string, unknown>): Readonly<Record<string, JsonValue>> {
  return JSON.parse(JSON.stringify(value)) as Readonly<Record<string, JsonValue>>
}

function verificationResult(value: readonly string[] | WorkflowTaskVerificationResult | undefined, enforcement: 'hard' | 'warn'): WorkflowTaskVerificationResult {
  if (value === undefined) return { ok: true, reasons: [], enforcement }
  if (Array.isArray(value)) return { ok: value.length === 0, reasons: value, enforcement }
  return value as WorkflowTaskVerificationResult
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringLeaves)
  if (value === null || typeof value !== 'object') return []
  return Object.values(value).flatMap(stringLeaves)
}

function observedToolEvidence(agent: Agent | undefined): { readonly readPaths: readonly string[]; readonly mutationToolCalls: readonly string[] } {
  if (agent === undefined) return { readPaths: [], mutationToolCalls: [] }
  const successful = new Set<string>()
  for (const event of agent.session.events) {
    if (event.type !== 'tool/result' || event.data.error !== undefined) continue
    for (const block of event.data.message.content) if (block.type === 'tool-result' && block.isError !== true) successful.add(String(block.toolCallId))
  }
  const readPaths: string[] = []
  const mutationToolCalls: string[] = []
  const mutationNames = new Set(['write', 'edit', 'str_replace_editor', 'bash', 'pwsh', 'terminal_create', 'terminal_write', 'cordis_mount', 'cordis_unmount'])
  for (const event of agent.session.events) {
    if (event.type !== 'tool/call' || !successful.has(String(event.data.callId))) continue
    if (mutationNames.has(event.data.name)) mutationToolCalls.push(event.data.name)
    if (!['read', 'read_image', 'grep', 'glob'].includes(event.data.name)) continue
    try { readPaths.push(...stringLeaves(JSON.parse(event.data.arguments) as unknown)) } catch { /* malformed calls cannot prove evidence */ }
  }
  return { readPaths: [...new Set(readPaths)], mutationToolCalls: [...new Set(mutationToolCalls)] }
}

function pathObserved(required: string, observed: readonly string[], cwd: string): boolean {
  const wanted = resolve(cwd, required).replaceAll('\\', '/').toLowerCase()
  return observed.some(value => {
    const candidate = resolve(cwd, value).replaceAll('\\', '/').toLowerCase()
    return candidate === wanted
  })
}

function latestAssistantText(agent: Agent | undefined, fallback: string): string {
  if (agent === undefined) return fallback
  for (const event of [...agent.session.events].reverse()) {
    if (event.type !== 'assistant/message') continue
    const text = event.data.message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
    if (text.length > 0) return text
  }
  return fallback
}

function childRecordedCompleted(agent: Agent | undefined): boolean {
  if (agent === undefined) return false
  const end = [...agent.session.events].reverse().find(event => event.type === 'turn/end')
  return end?.type === 'turn/end' && end.data.reason.kind === 'completed'
}

interface WorkspaceState {
  readonly fingerprint: string
  readonly changedPaths: readonly string[]
  readonly requiredPathFingerprints: Readonly<Record<string, string>>
}

function workspacePath(cwd: string, requested: string): { readonly absolute: string; readonly normalized: string } | undefined {
  const absoluteCwd = resolve(cwd)
  const absolute = resolve(absoluteCwd, requested)
  const child = relative(absoluteCwd, absolute)
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return undefined
  return { absolute, normalized: child.replaceAll('\\', '/') }
}

async function filesystemFingerprint(path: string): Promise<string> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return createHash('sha256').update('symlink\0').update(await readlink(path)).digest('hex')
    if (info.isFile()) return createHash('sha256').update('file\0').update(await readFile(path)).digest('hex')
    if (info.isDirectory()) {
      const entries = (await readdir(path)).sort()
      const hash = createHash('sha256').update('directory\0')
      for (const entry of entries) hash.update(entry).update('\0').update(await filesystemFingerprint(resolve(path, entry))).update('\0')
      return hash.digest('hex')
    }
    return createHash('sha256').update(`other\0${info.mode}\0${info.size}`).digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

async function requiredPathFingerprint(cwd: string, requested: string): Promise<{ readonly normalized: string; readonly fingerprint: string } | undefined> {
  const target = workspacePath(cwd, requested)
  if (target === undefined) return undefined
  const [{ stdout: status }, { stdout: diff }, { stdout: staged }, worktree] = await Promise.all([
    execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', target.normalized], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }),
    execFileAsync('git', ['diff', '--binary', 'HEAD', '--', target.normalized], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }),
    execFileAsync('git', ['diff', '--binary', '--cached', 'HEAD', '--', target.normalized], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }),
    filesystemFingerprint(target.absolute),
  ])
  return { normalized: target.normalized, fingerprint: createHash('sha256').update(status).update('\0').update(diff).update('\0').update(staged).update('\0').update(worktree).digest('hex') }
}

async function gitWorkspaceState(cwd: string, requiredPaths: readonly string[] = []): Promise<WorkspaceState | undefined> {
  try {
    const [{ stdout: status }, { stdout: diff }, required] = await Promise.all([
      execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }),
      execFileAsync('git', ['diff', '--binary', 'HEAD'], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }),
      Promise.all(requiredPaths.map(async path => await requiredPathFingerprint(cwd, path))),
    ])
    const changedPaths = status.split('\0').filter(Boolean).flatMap(record => {
      const value = record.length > 3 ? record.slice(3) : ''
      return value.length === 0 ? [] : [value.replaceAll('\\', '/')]
    })
    const fingerprint = createHash('sha256').update(status).update('\0').update(diff).digest('hex')
    const requiredPathFingerprints = Object.fromEntries(required.filter((item): item is NonNullable<typeof item> => item !== undefined).map(item => [item.normalized.toLowerCase(), item.fingerprint]))
    return { fingerprint, changedPaths: [...new Set(changedPaths)], requiredPathFingerprints }
  } catch { return undefined }
}

interface SessionScopedWorkflowRunStartData extends ToolWorkflowRunStartData {
  /** Generic DSH Conversation coordinate: null explicitly owns this event at Session scope. */
  readonly turn: null
}

function appendNative<T extends keyof SessionEventMap>(session: Session, type: T, data: SessionEventMap[T]): void {
  const append = session.append.bind(session) as (event: T, value: SessionEventMap[T]) => void
  append(type, data)
}

function appendSessionScopedRunStart(session: Session, data: SessionScopedWorkflowRunStartData): void {
  const append = session.append.bind(session) as (event: 'tool-workflow/run-start', value: SessionScopedWorkflowRunStartData) => void
  append('tool-workflow/run-start', data)
}

const DEFAULT_READ_ONLY_TOOLS = ['read', 'read_image', 'glob', 'grep', 'lsp', 'skill', 'web_search'] as const

export function resolveReadOnlyToolFilter(parent: Agent, configured: readonly string[] = DEFAULT_READ_ONLY_TOOLS, denied: readonly string[] = []): ToolRestriction {
  const schemas = parent.ctx?.tools?.schemas(parent) ?? []
  const visible = new Set(schemas.map(schema => schema.name).filter(name => name !== 'run_code'))
  const deny = new Set(denied)
  return { allow: [...new Set(configured)].filter(name => visible.has(name) && !deny.has(name)) }
}

export class WorkflowSemaphore {
  private active = 0
  private readonly waiters: Array<{
    readonly signal: AbortSignal
    readonly resolve: (release: () => void) => void
    readonly reject: (error: WorkflowControlError) => void
    readonly onAbort: () => void
  }> = []
  constructor(private readonly limit: number) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new WorkflowControlError('workflow stopped')
    if (this.active >= this.limit) {
      const release = await new Promise<() => void>((resolve, reject) => {
      const waiter = {
        signal, resolve, reject,
        onAbort: (): void => {
          const index = this.waiters.indexOf(waiter)
          if (index < 0) return
          this.waiters.splice(index, 1)
          reject(new WorkflowControlError('workflow stopped'))
        },
      }
      this.waiters.push(waiter)
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      })
      if (signal.aborted) {
        release()
        throw new WorkflowControlError('workflow stopped')
      }
      return release
    }
    this.active += 1
    return this.lease()
  }
  private lease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift()!
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        if (waiter.signal.aborted) {
          waiter.reject(new WorkflowControlError('workflow stopped'))
          continue
        }
        // Transfer this permit atomically. `active` stays unchanged until the
        // admitted caller releases its own lease.
        waiter.resolve(this.lease())
        return
      }
      this.active -= 1
    }
  }
}

async function gitRepository(cwd: string): Promise<boolean> {
  try { await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, windowsHide: true }); return true } catch { return false }
}

function preflightLists(required: readonly string[] | undefined, available: readonly string[], label: string, errors: string[]): void {
  for (const item of required ?? []) if (!available.includes(item)) errors.push(`required ${label} "${item}" is unavailable`)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new WorkflowControlError(`${label} contains unknown field "${key}"`)
}

function optionalString(value: Record<string, unknown>, key: string, label: string): void {
  if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].trim().length === 0)) throw new WorkflowControlError(`${label}.${key} must be a non-empty string when provided`)
}

function optionalStrings(value: Record<string, unknown>, key: string, label: string): void {
  const items = value[key]
  if (items !== undefined && (!Array.isArray(items) || items.some(item => typeof item !== 'string' || item.trim().length === 0))) throw new WorkflowControlError(`${label}.${key} must be an array of non-empty strings when provided`)
}

/** Validate an authored child-agent request against the same contract used at dispatch. */
export function validateWorkflowTaskInput(value: WorkflowSpawnAgentInput): WorkflowSpawnAgentInput {
  const input = value as unknown as Record<string, unknown>
  exactKeys(input, ['name', 'phase', 'prompt', 'scopeSummary', 'constraints', 'readOnly', 'subagentType', 'target', 'modelHint', 'provider', 'model', 'isolation', 'effort', 'maxTokens', 'evidenceRefs', 'verification', 'outputSchema', 'terseResult'], 'workflow agent input')
  optionalString(input, 'name', 'workflow agent input')
  optionalString(input, 'prompt', 'workflow agent input')
  if (typeof input.name !== 'string' || typeof input.prompt !== 'string') throw new WorkflowControlError('workflow agent input requires non-empty name and prompt')
  for (const key of ['phase', 'scopeSummary', 'subagentType', 'provider', 'model', 'effort']) optionalString(input, key, 'workflow agent input')
  for (const key of ['constraints', 'evidenceRefs']) optionalStrings(input, key, 'workflow agent input')
  for (const key of ['readOnly', 'terseResult']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new WorkflowControlError(`workflow agent input.${key} must be a boolean when provided`)
  if (input.modelHint !== undefined && !['fast', 'balanced', 'deep'].includes(String(input.modelHint))) throw new WorkflowControlError('workflow agent input.modelHint must be fast, balanced, or deep')
  if (input.isolation !== undefined && !['shared-cwd', 'worktree'].includes(String(input.isolation))) throw new WorkflowControlError('workflow agent input.isolation must be shared-cwd or worktree')
  if (input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens) || Number(input.maxTokens) <= 0)) throw new WorkflowControlError('workflow agent input.maxTokens must be a positive safe integer')
  if (input.target !== undefined) {
    if (typeof input.target !== 'object' || input.target === null || Array.isArray(input.target)) throw new WorkflowControlError('workflow agent input.target must be an object')
    const target = input.target as Record<string, unknown>
    exactKeys(target, ['agentId', 'expectedConfigurationRevision'], 'workflow agent input.target')
    optionalString(target, 'agentId', 'workflow agent input.target')
    optionalString(target, 'expectedConfigurationRevision', 'workflow agent input.target')
    if (typeof target.agentId !== 'string') throw new WorkflowControlError('workflow agent input.target.agentId is required')
  }
  if (input.verification !== undefined) {
    if (typeof input.verification !== 'object' || input.verification === null || Array.isArray(input.verification)) throw new WorkflowControlError('workflow agent input.verification must be an object')
    const verification = input.verification as Record<string, unknown>
    exactKeys(verification, ['enforcement', 'requiresMutation', 'requiredChangedPaths', 'requiredReadPaths', 'minFinalTextChars', 'rejectPreparatoryFinalText'], 'workflow agent input.verification')
    if (verification.enforcement !== undefined && verification.enforcement !== 'hard' && verification.enforcement !== 'warn') throw new WorkflowControlError('workflow agent input.verification.enforcement must be hard or warn')
    for (const key of ['requiresMutation', 'rejectPreparatoryFinalText']) if (verification[key] !== undefined && typeof verification[key] !== 'boolean') throw new WorkflowControlError(`workflow agent input.verification.${key} must be a boolean when provided`)
    for (const key of ['requiredChangedPaths', 'requiredReadPaths']) optionalStrings(verification, key, 'workflow agent input.verification')
    if (verification.minFinalTextChars !== undefined && (!Number.isSafeInteger(verification.minFinalTextChars) || Number(verification.minFinalTextChars) <= 0)) throw new WorkflowControlError('workflow agent input.verification.minFinalTextChars must be a positive safe integer')
  }
  if (input.outputSchema !== undefined) {
    try { assertObjectJsonSchema(input.outputSchema) } catch (error) {
      throw new WorkflowControlError(`workflow agent input.outputSchema is invalid: ${message(error)}`)
    }
  }
  return value
}

export interface WorkflowTaskAdmissionContext {
  readonly manifest: WorkflowManifest
  readonly config: ResolvedWorkflowConfig
  readonly totalSpawned: number
  readonly subagents?: Pick<SubagentRuntime, 'getProvider'>
  readonly dispatchAvailable?: boolean
  readonly isolationAvailable?: boolean
}

export interface WorkflowTaskAdmission {
  readonly readOnly: boolean
  readonly route: ResolvedWorkflowConfig['modelTiers'][WorkflowModelHint]
  readonly allocation: number
  readonly subagentProvider: string
}

function workflowTaskRoute(input: WorkflowSpawnAgentInput, readOnly: boolean, config: ResolvedWorkflowConfig): ResolvedWorkflowConfig['modelTiers'][WorkflowModelHint] {
  const hasExplicitSelector = input.provider !== undefined || input.model !== undefined
  const hint = hasExplicitSelector || input.modelHint === undefined || input.modelHint === 'balanced' || (input.modelHint === 'fast' && !readOnly)
    ? 'balanced'
    : input.modelHint
  return config.modelTiers[hint]
}

/** Validate deterministic task admission rules shared by smoke and real execution. */
export function validateWorkflowTaskAdmission(input: WorkflowSpawnAgentInput, context: WorkflowTaskAdmissionContext): WorkflowTaskAdmission {
  validateWorkflowTaskInput(input)
  if (context.totalSpawned >= Math.min(context.manifest.maxAgents, context.config.maxAgents)) throw new WorkflowControlError('workflow agent limit exceeded')
  if (context.manifest.readOnly && input.readOnly === false) throw new WorkflowControlError(`workflow manifest readOnly=true cannot spawn write-capable child "${input.name}"`)
  if ((input.target !== undefined || input.effort !== undefined) && context.dispatchAvailable === false) throw new WorkflowControlError('target/effort dispatch requires a registered workflow dispatch adapter')
  if (input.isolation === 'worktree' && context.isolationAvailable === false) throw new WorkflowControlError('workflow worktree isolation requested but no isolation adapter is configured')
  const readOnly = context.manifest.readOnly || input.readOnly === true
  const route = workflowTaskRoute(input, readOnly, context.config)
  const allocation = input.maxTokens ?? route.maxTokens ?? 0
  if (context.manifest.tokenBudget !== undefined) {
    if (allocation <= 0) throw new WorkflowControlError('token-budgeted workflow task requires maxTokens through its task or model tier')
    if (allocation > context.manifest.tokenBudget) throw new WorkflowControlError('workflow token budget exceeded before agent start')
  }
  const subagentProvider = input.subagentType ?? route.subagentProvider ?? context.config.defaultProvider
  const descriptor = context.subagents?.getProvider(subagentProvider)
  if (context.subagents !== undefined && descriptor === undefined) throw new WorkflowControlError(`subagent provider "${subagentProvider}" is unavailable`)
  if (readOnly && descriptor !== undefined && !descriptor.capabilities.toolFilter) throw new WorkflowControlError(`subagent provider "${subagentProvider}" cannot enforce read-only tool filtering`)
  if (input.outputSchema !== undefined && descriptor !== undefined && !descriptor.capabilities.outputSchema) throw new WorkflowControlError(`subagent provider "${subagentProvider}" cannot produce structured output`)
  return { readOnly, route, allocation, subagentProvider }
}

export class DynamicWorkflowEngine {
  private readonly runs = new Map<string, MutableRun>()
  private readonly subscribers = new Set<(event: WorkflowEvent, snapshot: WorkflowRunSnapshot) => void>()
  private readonly now: () => number
  private readonly id: () => string

  constructor(private readonly deps: WorkflowEngineDependencies) {
    this.now = deps.now ?? (() => Date.now())
    this.id = deps.id ?? (() => `run-${randomUUID()}`)
  }

  async preflight(input: WorkflowStartInput): Promise<WorkflowPreflightResult> {
    const errors: string[] = []
    const warnings: string[] = []
    const capsule = input.module.capsule
    const requirements = capsule?.requires
    const cwd = cwdOf(input.parent)
    if (requirements?.environment?.includes('git-repo') === true && !await gitRepository(cwd)) errors.push('workflow requires a git repository')
    if (requirements?.environment?.includes('worktree-capable') === true && this.deps.isolation === undefined) errors.push('workflow requires worktree isolation but no DSH isolation adapter is configured')
    preflightLists(requirements?.tools, this.deps.config.availableTools, 'tool', errors)
    preflightLists(requirements?.mcp, this.deps.config.availableMcp, 'MCP server', errors)
    preflightLists(requirements?.skills, this.deps.config.availableSkills, 'skill', errors)
    for (const tier of requirements?.modelTiers ?? []) if (this.deps.config.modelTiers[tier] === undefined) errors.push(`required model tier "${tier}" is unavailable`)
    if (requirements?.userInteraction === true && this.deps.userInteractionAvailable !== true) errors.push('workflow requires user interaction but no DSH user-questions provider is configured')
    if (input.module.manifest.mayUseWorktree === true && this.deps.isolation === undefined) warnings.push('worktree requests will fail because no isolation adapter is configured')
    const route = this.deps.config.modelTiers.balanced
    if (input.module.manifest.tokenBudget !== undefined && route.maxTokens === undefined) errors.push('token-budgeted workflows require maxTokens on the balanced model tier')
    const approvalSummary = `${input.module.execution} workflow "${input.module.manifest.name}"; max ${input.module.manifest.maxAgents} agents / ${input.module.manifest.maxConcurrency} concurrent; ${input.module.manifest.readOnly ? 'read-only' : 'may mutate'}${input.module.manifest.mayUseWorktree === true ? '; may use worktrees' : ''}`
    return { ok: errors.length === 0, errors, warnings, approvalSummary }
  }

  async start(input: WorkflowStartInput): Promise<WorkflowRun> {
    const preflight = await this.preflight(input)
    if (!preflight.ok) throw new Error(`workflow preflight failed: ${preflight.errors.join('; ')}`)
    if (input.module.capsule !== undefined) validateWorkflowArgs(input.module.capsule, input.args === undefined ? {} : input.args)
    const normalizedInput: WorkflowStartInput = input.args === undefined ? { ...input, args: {} } : input
    const runId = this.id()
    const controller = new AbortController()
    if (input.signal?.aborted === true) controller.abort(input.signal.reason)
    const forward = (): void => controller.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', forward, { once: true })
    const writer = this.deps.store.create(runId)
    const startedAt = this.now()
    const snapshot: WorkflowRunSnapshot = {
      runId,
      workflow: input.module.manifest.name,
      displayName: input.displayName ?? input.module.manifest.name,
      status: 'running',
      source: input.source,
      execution: input.module.execution,
      startedAt,
      totalSpawned: 0,
      activeAgents: 0,
      eventCount: 0,
      artifacts: [],
      ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
      ...(input.savedWorkflowName === undefined ? {} : { savedWorkflowName: input.savedWorkflowName }),
      ...(input.revisionOf === undefined ? {} : { revisionOf: input.revisionOf }),
      ...(input.resumeFromRunId === undefined ? {} : { resumedFromRunId: input.resumeFromRunId }),
    }
    let unusedResolve!: (value: WorkflowTaskResult) => void
    let unusedReject!: (error: unknown) => void
    void unusedResolve
    void unusedReject
    const mutable: MutableRun = {
      snapshot,
      input: normalizedInput,
      controller,
      writer,
      tasks: new Map(),
      pauseWaiters: new Set(),
      cacheOccurrences: new Map(),
      active: 0,
      peakConcurrency: 0,
      reservedTokens: 0,
      spentTokens: 0,
      taskSequence: 0,
      nestingDepth: input.nestingDepth ?? 0,
      nativeSession: input.parent.session,
    }
    this.runs.set(runId, mutable)
    if (input.module.capsule !== undefined) writer.snapshotScript(input.module.capsule)
    this.persist(mutable)
    const done = this.execute(mutable, preflight).finally(() => input.signal?.removeEventListener('abort', forward))
    mutable.completion = done
    return { runId, done, getSnapshot: () => structuredClone(mutable.snapshot) }
  }

  list(): readonly WorkflowRunSnapshot[] {
    const live = [...this.runs.values()].map(run => structuredClone(run.snapshot))
    const liveIds = new Set(live.map(run => run.runId))
    return [...live, ...this.deps.store.list().filter(run => !liveIds.has(run.runId))].sort((a, b) => b.startedAt - a.startedAt)
  }

  get(runId: string): WorkflowRunSnapshot | undefined {
    const live = this.runs.get(runId)
    return live === undefined ? this.deps.store.get(runId) : structuredClone(live.snapshot)
  }

  subscribe(listener: (event: WorkflowEvent, snapshot: WorkflowRunSnapshot) => void): () => void {
    this.subscribers.add(listener)
    return () => { this.subscribers.delete(listener) }
  }

  isActive(runId: string): boolean {
    const run = this.runs.get(runId)
    return run !== undefined && !TERMINAL.has(run.snapshot.status)
  }

  async disposeAll(reason = 'workflow service disposed'): Promise<void> {
    const active = [...this.runs.values()]
    for (const run of active) this.stop(run.snapshot.runId, reason)
    await Promise.allSettled(active.map(async run => await run.completion))
    this.subscribers.clear()
  }

  pause(runId: string): boolean {
    const run = this.runs.get(runId)
    if (run === undefined || run.snapshot.status !== 'running') return false
    run.snapshot = { ...run.snapshot, status: 'paused' }
    this.emit(run, 'workflow-paused', { runId })
    return true
  }

  resume(runId: string): boolean {
    const run = this.runs.get(runId)
    if (run === undefined || run.snapshot.status !== 'paused') return false
    run.snapshot = { ...run.snapshot, status: 'running' }
    this.emit(run, 'workflow-resumed', { runId })
    for (const resolve of run.pauseWaiters) resolve()
    run.pauseWaiters.clear()
    return true
  }

  stop(runId: string, reason = 'workflow stopped'): boolean {
    const run = this.runs.get(runId)
    if (run === undefined || TERMINAL.has(run.snapshot.status)) return false
    run.snapshot = { ...run.snapshot, status: 'stopped', error: reason }
    run.controller.abort(reason)
    for (const resolve of run.pauseWaiters) resolve()
    run.pauseWaiters.clear()
    for (const task of run.tasks.values()) {
      if (task.status === 'running') {
        task.run?.localAgent?.cancel({ kind: 'parent' })
        void task.run?.dispose()
      }
    }
    return true
  }

  private async execute(run: MutableRun, preflight: WorkflowPreflightResult): Promise<WorkflowRunSnapshot> {
    const infoId = WorkflowRunId(run.snapshot.runId)
    // Dynamic workflows outlive the tool step that launches them. Session-scope
    // the start so DSH does not infer an interruption when that step closes.
    appendSessionScopedRunStart(run.nativeSession, { runId: infoId, name: run.snapshot.workflow, turn: null })
    this.emit(run, 'workflow-started', { runId: run.snapshot.runId, workflow: run.snapshot.workflow })
    try {
      if (this.needsApproval(run.input)) {
        if (this.deps.approval === undefined) throw new Error('workflow approval is required but the DSH approval service is unavailable')
        const outcome = await this.deps.approval.request({ agent: run.input.parent, toolName: 'run_workflow', reason: preflight.approvalSummary, signal: run.controller.signal })
        if (outcome !== 'allowed-once') {
          run.snapshot = { ...run.snapshot, status: 'denied', error: `workflow approval ${outcome}` }
          this.emit(run, 'workflow-stopped', { reason: `approval ${outcome}` })
          return this.finish(run)
        }
      }
      const api = this.createApi(run, run.input.args)
      let result: unknown
      if (run.input.module.source !== undefined) {
        result = await runRestrictedWorkflowScript({
          source: run.input.module.source,
          wf: api,
          args: run.input.args,
          filename: `${run.snapshot.workflow}.workflow.js`,
          syncTimeoutMs: this.deps.config.scriptSyncTimeoutMs,
          wallTimeoutMs: this.deps.config.scriptWallTimeoutMs,
          onTimeout: () => { this.stop(run.snapshot.runId, 'workflow script timed out') },
        })
      } else if (run.input.module.run !== undefined) {
        result = await run.input.module.run(api, run.input.args)
      } else throw new Error('workflow module has neither source nor run function')
      await Promise.allSettled([...run.tasks.values()].map(task => task.promise))
      if (run.controller.signal.aborted || run.snapshot.status === 'stopped') {
        run.snapshot = { ...run.snapshot, status: 'stopped', error: message(run.controller.signal.reason ?? 'workflow stopped') }
        this.emit(run, 'workflow-stopped', { reason: run.snapshot.error })
      } else {
        const materialized = snapshotWorkflowJson(result === undefined ? null : result, 'workflow result')
        const summary = typeof materialized === 'string' ? materialized : JSON.stringify(materialized)
        run.snapshot = { ...run.snapshot, status: 'completed', result: materialized, resultSummary: summary.slice(0, this.deps.config.maxResultChars) }
        this.emit(run, 'workflow-completed', { resultSummary: run.snapshot.resultSummary })
      }
    } catch (error) {
      const stopped = run.controller.signal.aborted || run.snapshot.status === 'stopped'
      run.snapshot = { ...run.snapshot, status: stopped ? 'stopped' : 'failed', error: message(error) }
      this.emit(run, stopped ? 'workflow-stopped' : 'workflow-failed', { error: run.snapshot.error })
      await Promise.allSettled([...run.tasks.values()].map(async task => { await task.run?.dispose() }))
    }
    return this.finish(run)
  }

  private finish(run: MutableRun): WorkflowRunSnapshot {
    const endedAt = this.now()
    const events = run.writer === undefined ? [] : this.deps.store.getEvents(run.snapshot.runId)
    const cost: WorkflowCostReport = {
      wallClockDurationMs: Math.max(0, endedAt - run.snapshot.startedAt),
      agentsStarted: run.snapshot.totalSpawned,
      agentsCompleted: [...run.tasks.values()].filter(task => task.result !== undefined).length,
      cacheHits: events.filter(event => event.type === 'cache-hit').length,
      tokenUsage: run.spentTokens,
      peakConcurrency: run.peakConcurrency,
    }
    run.snapshot = { ...run.snapshot, endedAt, activeAgents: 0, cost }
    run.snapshot = { ...run.snapshot, outcome: this.projectOutcome(run) }
    this.persist(run)
    const stopReason = run.snapshot.status === 'completed' ? 'completed' : run.snapshot.status === 'stopped' ? 'cancelled' : 'error'
    appendNative(run.nativeSession, 'tool-workflow/run-end', { runId: WorkflowRunId(run.snapshot.runId), stopReason })
    this.runs.delete(run.snapshot.runId)
    this.deps.store.prune({ keep: this.deps.config.maxRetainedRuns })
    return structuredClone(run.snapshot)
  }

  private needsApproval(input: WorkflowStartInput): boolean {
    if (input.requireApproval !== undefined) return input.requireApproval
    if (this.deps.config.approvalMode === 'always') return true
    return this.deps.config.approvalMode === 'generated-and-local'
      && (input.module.execution === 'capability-generated' || input.module.execution === 'trusted-local')
  }

  private emit(run: MutableRun, type: WorkflowEvent['type'], data: Record<string, unknown>): WorkflowEvent {
    const event = run.writer.append(type, jsonData(data))
    run.snapshot = { ...run.snapshot, eventCount: event.seq + 1 }
    this.persist(run)
    const detached = structuredClone(run.snapshot)
    for (const subscriber of this.subscribers) {
      try { subscriber(event, detached) } catch { /* observers are contained */ }
    }
    return event
  }

  private persist(run: MutableRun): void {
    run.snapshot = { ...run.snapshot, process: this.projectProcess(run) }
    run.writer.writeSnapshot(run.snapshot)
  }

  private projectProcess(run: MutableRun): WorkflowProcessSnapshot {
    const events = this.deps.store.getEvents(run.snapshot.runId)
    const phaseNames = [...new Set([
      ...run.input.module.manifest.phases,
      ...events.flatMap(event => event.type === 'phase-started' || event.type === 'phase-completed' ? [String(event.data.name ?? '')] : []),
      ...[...run.tasks.values()].flatMap(task => task.input.phase ?? task.phase ?? []),
    ].filter(Boolean))]
    const phaseIdByName = new Map(phaseNames.map((name, index) => [name, `phase:${index + 1}`]))
    const phaseItems: WorkflowProcessItem[] = phaseNames.map(name => {
      const started = events.find(event => event.type === 'phase-started' && event.data.name === name)
      const ended = [...events].reverse().find(event => event.type === 'phase-completed' && event.data.name === name)
      return {
        id: phaseIdByName.get(name)!, title: name, kind: 'phase', status: ended === undefined
          ? TERMINAL.has(run.snapshot.status) ? 'skipped' : started === undefined ? 'pending' : 'running'
          : 'completed',
        ...(started === undefined ? {} : { startedAt: new Date(started.time).toISOString() }),
        ...(ended === undefined ? {} : { endedAt: new Date(ended.time).toISOString() }),
      }
    })
    const agentItems: WorkflowProcessItem[] = [...run.tasks.values()].sort((left, right) => left.sequence - right.sequence).map(task => {
      let status: WorkflowProcessItemStatus
      if (task.status === 'running') status = task.nativeStarted ? 'running' : 'pending'
      else if (task.status === 'completed' || task.status === 'completed_unverified') status = 'completed'
      else if (task.status === 'failed') status = 'failed'
      else status = task.nativeStarted ? 'cancelled' : 'skipped'
      const phaseName = task.input.phase ?? task.phase
      return {
        id: task.id, title: task.input.name, kind: 'agent' as const, status,
        ...(phaseName === undefined || phaseIdByName.get(phaseName) === undefined ? {} : { phaseId: phaseIdByName.get(phaseName)! }),
        agentId: task.id,
        ...(task.childId === undefined ? {} : { childAgentId: task.childId }),
        ...(task.result?.finalText === undefined || task.result.finalText.length === 0 ? {} : { summary: task.result.finalText.slice(0, this.deps.config.maxResultChars) }),
        ...(task.origin === undefined ? {} : { origin: task.origin }),
        startedAt: new Date(task.startedAt).toISOString(),
        ...(task.result?.endedAt === undefined ? {} : { endedAt: new Date(task.result.endedAt).toISOString() }),
      }
    })
    const stepItems: WorkflowProcessItem[] = []
    const openSteps = new Map<string, WorkflowProcessItem[]>()
    for (const event of events) {
      if (event.type !== 'nested-started' && event.type !== 'nested-completed' && event.type !== 'synthesis-started' && event.type !== 'synthesis-completed') continue
      const title = event.type.startsWith('nested-') ? `workflow:${String(event.data.name ?? 'nested')}` : 'synthesis'
      if (event.type.endsWith('-started')) {
        const item: WorkflowProcessItem = { id: `step:${event.seq}`, title, kind: 'step', status: 'running', startedAt: new Date(event.time).toISOString() }
        stepItems.push(item)
        openSteps.set(title, [...(openSteps.get(title) ?? []), item])
      } else {
        const item = openSteps.get(title)?.find(candidate => candidate.status === 'running')
        if (item !== undefined) Object.assign(item, { status: 'completed', endedAt: new Date(event.time).toISOString() })
      }
    }
    const artifactItems: WorkflowProcessItem[] = run.snapshot.artifacts.map((artifact, index) => ({
      id: `artifact:${index + 1}:${artifact.name}`, title: artifact.name, kind: 'artifact', status: 'completed', summary: artifact.path,
    }))
    const items = [...phaseItems, ...agentItems, ...stepItems, ...artifactItems]
    const counts: Record<WorkflowProcessItemStatus, number> = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 }
    for (const item of items) counts[item.status] += 1
    const agents = items.filter(item => item.kind === 'agent')
    const runStatus: WorkflowProcessSnapshot['status'] = run.snapshot.status === 'stopped' || run.snapshot.status === 'denied'
      ? 'cancelled'
      : run.snapshot.status
    return {
      runId: run.snapshot.runId, workflowName: run.snapshot.workflow, status: runStatus,
      startedAt: new Date(run.snapshot.startedAt).toISOString(), updatedAt: new Date(this.now()).toISOString(), items, counts,
      progress: {
        spawnedAgents: run.snapshot.totalSpawned,
        finishedAgents: agents.filter(item => item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled' || item.status === 'skipped').length,
        activeAgents: agents.filter(item => item.status === 'running').length,
        failedAgents: agents.filter(item => item.status === 'failed').length,
        stoppedAgents: agents.filter(item => item.status === 'cancelled' || item.status === 'skipped').length,
        replayedAgents: agents.filter(item => item.origin === 'replayed-from-cache').length,
      },
    }
  }

  private projectOutcome(run: MutableRun): WorkflowOutcome {
    const taskResults = [...run.tasks.values()].sort((left, right) => left.sequence - right.sequence).flatMap(task => task.result === undefined ? [] : [task.result])
    const results = taskResults.map(result => ({
      taskId: result.taskId,
      name: result.name,
      status: result.status,
      summary: result.finalText.trim(),
      ...(result.structured === undefined ? {} : { structured: result.structured }),
      artifacts: [...(result.artifacts ?? [])],
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    }))
    const coverage = taskResults.filter(result => result.status === 'completed' || result.status === 'completed_unverified').map(result => result.name)
    const unresolved = taskResults.filter(result => result.status === 'failed' || result.status === 'stopped').map(result => result.name)
    const errors: Array<{ taskId?: string; name?: string; message: string }> = taskResults.filter(result => result.status === 'failed' || result.status === 'stopped').map(result => ({ taskId: result.taskId, name: result.name, message: result.stopReason ?? (result.finalText.trim() || result.status) }))
    if (run.snapshot.error !== undefined) errors.push({ message: run.snapshot.error })
    const measured = taskResults.reduce((sum, result) => ({
      inputTokens: sum.inputTokens + (result.usage?.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (result.usage?.outputTokens ?? 0),
      cacheReadTokens: sum.cacheReadTokens + (result.usage?.cacheReadTokens ?? 0),
      totalTokens: sum.totalTokens + (result.usage?.totalTokens ?? result.tokenUsage ?? 0),
    }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 })
    const status: WorkflowOutcome['status'] = run.snapshot.status === 'stopped' || run.snapshot.status === 'denied'
      ? 'interrupted'
      : run.snapshot.status === 'failed'
        ? 'failed'
        : unresolved.length > 0
          ? 'partial'
          : 'completed'
    const artifacts = [...run.snapshot.artifacts]
    const knownArtifacts = new Set(artifacts.map(artifact => `${artifact.name}\u0000${artifact.path}`))
    for (const path of taskResults.flatMap(result => result.artifacts ?? [])) {
      const key = `${path}\u0000${path}`
      if (!knownArtifacts.has(key)) { knownArtifacts.add(key); artifacts.push({ name: path, path }) }
    }
    return {
      runId: run.snapshot.runId, status, summary: run.snapshot.resultSummary ?? run.snapshot.error ?? '', results,
      artifacts, coverage, unresolved, errors,
      usage: { ...measured, totalSpawned: run.snapshot.totalSpawned },
    }
  }

  private async waitAdmission(run: MutableRun): Promise<void> {
    while (run.snapshot.status === 'paused' && !run.controller.signal.aborted) {
      await new Promise<void>(resolve => run.pauseWaiters.add(resolve))
    }
    if (run.controller.signal.aborted) throw new WorkflowControlError('workflow stopped')
  }

  private createApi(
    run: MutableRun,
    args: unknown,
    nestingDepth = 0,
    semaphore = new WorkflowSemaphore(Math.min(run.input.module.manifest.maxConcurrency, this.deps.config.maxConcurrency)),
    phaseState: { current?: string } = {},
  ): WorkflowApi {
    let phaseToken = 0
    const phases = new Map<number, string | undefined>()
    const beginPhase = (name: string): number => {
      const token = ++phaseToken
      phases.set(token, phaseState.current)
      phaseState.current = name
      run.snapshot = { ...run.snapshot, phase: name }
      this.emit(run, 'phase-started', { name })
      return token
    }
    const endPhase = (token: number): void => {
      if (!phases.has(token)) throw new WorkflowControlError(`workflow phase token ${token} is not active`)
      const name = phaseState.current ?? 'unknown'
      const previous = phases.get(token)
      phases.delete(token)
      this.emit(run, 'phase-completed', { name })
      if (previous === undefined) {
        delete phaseState.current
        const { phase: _phase, ...withoutPhase } = run.snapshot
        void _phase
        run.snapshot = withoutPhase
      } else {
        phaseState.current = previous
        run.snapshot = { ...run.snapshot, phase: previous }
      }
    }
    const start = (input: WorkflowSpawnAgentInput): Promise<WorkflowTaskHandle> => this.startTask(run, semaphore, validateWorkflowTaskInput(snapshotWorkflowJson(input, 'workflow agent input')), phaseState.current)
    return Object.freeze({
      [WORKFLOW_INTERNAL]: Object.freeze({ beginPhase, endPhase }),
      runId: run.snapshot.runId,
      args,
      budget: Object.freeze({
        total: run.input.module.manifest.tokenBudget ?? null,
        spent: () => run.spentTokens,
        remaining: () => run.input.module.manifest.tokenBudget === undefined ? Infinity : Math.max(0, run.input.module.manifest.tokenBudget - run.spentTokens - run.reservedTokens),
      }),
      phase: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        const token = beginPhase(name)
        try { return await fn() } finally { endPhase(token) }
      },
      spawnAgent: start,
      runAgent: async input => {
        try {
          const handle = await start(input)
          const result = await this.waitTask(run, handle.taskId)
          return result.status === 'failed' || result.status === 'stopped' ? null : result
        } catch (error) {
          if (isControlError(error)) throw error
          return null
        }
      },
      wait: async (taskId, options) => await this.waitTask(run, taskId, options?.timeoutMs),
      snapshot: async taskId => this.taskSnapshot(run, taskId),
      output: async taskId => this.taskSnapshot(run, taskId),
      send: async (taskId, content) => {
        const task = this.expectTask(run, taskId)
        if (task.status !== 'running' || task.run?.localAgent === undefined) throw new Error(`task "${taskId}" does not support live messaging on its selected provider`)
        task.run.localAgent.steer(createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'plugin', plugin: '@dsh-external/workflow', form: 'relay' } }))
        this.emit(run, 'agent-message', { taskId, content })
      },
      stop: async (taskId, reason) => {
        const task = this.expectTask(run, taskId)
        if (task.status !== 'running') return
        task.run?.localAgent?.cancel({ kind: 'parent' })
        await task.run?.dispose()
        this.emit(run, 'workflow-log', { message: `stop requested for ${taskId}`, data: { reason } })
      },
      parallel: async <T>(thunks: readonly (() => Promise<T>)[], options?: { readonly concurrency?: number }): Promise<(T | null)[]> => {
        const concurrency = options?.concurrency ?? thunks.length
        if (!Number.isSafeInteger(concurrency) || concurrency <= 0) throw new Error('parallel concurrency must be a positive integer')
        const values: (T | null)[] = Array.from({ length: thunks.length }, () => null)
        let cursor = 0
        const lane = async (): Promise<void> => {
          for (;;) {
            const index = cursor++
            if (index >= thunks.length) return
            try { values[index] = await thunks[index]!() } catch (error) {
              if (isControlError(error)) throw error
              values[index] = null
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, thunks.length)) }, lane))
        return values
      },
      pipeline: async <T>(items: readonly T[], ...stages: readonly ((value: unknown, item: T, index: number) => Promise<unknown>)[]): Promise<(unknown | null)[]> => await Promise.all(items.map(async (item, index) => {
        try { let value: unknown = item; for (const stage of stages) value = await stage(value, item, index); return value } catch (error) {
          if (isControlError(error)) throw error
          return null
        }
      })),
      synthesize: async synthesis => {
        const safeSynthesis = snapshotWorkflowJson(synthesis, 'workflow synthesis input')
        this.emit(run, 'synthesis-started', { rubric: safeSynthesis.rubric })
        const result = await this.startTask(run, semaphore, { name: 'synthesis', prompt: `Synthesize the supplied evidence using this rubric:\n${safeSynthesis.rubric}\n\nEvidence:\n${JSON.stringify(safeSynthesis.inputs)}`, readOnly: true, subagentType: this.deps.config.synthesisProvider, modelHint: 'deep' }, phaseState.current)
        const settled = await this.waitTask(run, result.taskId)
        this.emit(run, 'synthesis-completed', { taskId: result.taskId })
        return { text: settled.finalText }
      },
      workflow: async (name, args) => {
        if (nestingDepth >= 1) throw new WorkflowControlError('nested workflows are limited to one level')
        this.emit(run, 'nested-started', { name })
        const nested = await this.deps.resolveNested(name)
        const nestedArgs = snapshotWorkflowJson(args ?? {}, 'nested workflow args')
        if (nested.module.capsule !== undefined) validateWorkflowArgs(nested.module.capsule, nestedArgs)
        const nestedApi = this.createApi(run, nestedArgs, nestingDepth + 1, semaphore, phaseState)
        let result: unknown
        if (nested.module.source !== undefined) {
          result = await runRestrictedWorkflowScript({
            source: nested.module.source,
            wf: nestedApi,
            args: nestedArgs,
            filename: `${nested.module.manifest.name}.workflow.js`,
            syncTimeoutMs: this.deps.config.scriptSyncTimeoutMs,
            wallTimeoutMs: this.deps.config.scriptWallTimeoutMs,
            onTimeout: () => { this.stop(run.snapshot.runId, 'nested workflow script timed out') },
          })
        } else if (nested.module.run !== undefined) {
          result = await nested.module.run(nestedApi, nestedArgs)
        } else {
          throw new WorkflowControlError(`nested workflow "${name}" has neither source nor run function`)
        }
        const materialized = snapshotWorkflowJson(result === undefined ? null : result, `nested workflow "${name}" result`)
        this.emit(run, 'nested-completed', { name, runId: run.snapshot.runId })
        return materialized
      },
      artifact: async (name, value) => {
        const artifact = run.writer.artifact(name, snapshotWorkflowJson(value, 'workflow artifact'))
        run.snapshot = { ...run.snapshot, artifacts: [...run.snapshot.artifacts, artifact] }
        this.emit(run, 'artifact-written', { name, path: artifact.path })
        return artifact
      },
      log: event => {
        const normalized = typeof event === 'string' ? { message: event } : snapshotWorkflowJson(event, 'workflow log event')
        this.emit(run, 'workflow-log', normalized)
      },
    })
  }

  private async startTask(run: MutableRun, semaphore: WorkflowSemaphore, input: WorkflowSpawnAgentInput, phase?: string): Promise<WorkflowTaskHandle> {
    validateWorkflowTaskAdmission(input, {
      manifest: run.input.module.manifest, config: this.deps.config, totalSpawned: run.snapshot.totalSpawned,
      subagents: this.deps.subagents, dispatchAvailable: this.deps.dispatch !== undefined, isolationAvailable: this.deps.isolation !== undefined,
    })
    for (const ref of input.evidenceRefs ?? []) {
      const prefix = ['file:', 'diff:', 'finding:', 'task_id:'].find(candidate => ref.startsWith(candidate))
      if (prefix === undefined || ref.slice(prefix.length).trim().length === 0) throw new WorkflowControlError(`workflow agent input.evidenceRefs entry "${ref}" must use a non-empty file:, diff:, finding:, or task_id: reference`)
      if (prefix === 'task_id:') {
        const referencedTaskId = ref.slice(prefix.length).trim()
        if (!run.tasks.has(referencedTaskId)) throw new WorkflowControlError(`workflow agent input.evidenceRefs references unknown workflow task id "${referencedTaskId}"`)
      }
    }
    const taskId = `task-${++run.taskSequence}`
    const effectiveReadOnly = run.input.module.manifest.readOnly || input.readOnly === true
    const resolvedReadOnlyPolicy = effectiveReadOnly
      ? resolveReadOnlyToolFilter(run.input.parent, this.deps.config.readOnlyAllowedTools, this.deps.config.readOnlyToolFilter.deny)
      : null
    const cacheIdentity = {
      version: 2,
      workflow: { manifest: run.input.module.manifest, source: run.input.module.source ?? null },
      runtime: { pluginVersion: this.deps.config.pluginVersion, dshVersion: this.deps.config.dshVersion, verificationAdapter: this.deps.verification?.cacheIdentity ?? null },
      routing: { defaultProvider: this.deps.config.defaultProvider, modelTiers: this.deps.config.modelTiers, readOnlyPolicy: resolvedReadOnlyPolicy },
      input,
    }
    const occurrenceBase = JSON.stringify(cacheIdentity)
    const occurrence = (run.cacheOccurrences.get(occurrenceBase) ?? 0) + 1
    run.cacheOccurrences.set(occurrenceBase, occurrence)
    const cacheKey = run.writer.cacheKey(cacheIdentity, occurrence)
    const cached = run.input.resumeFromRunId === undefined ? undefined : run.writer.getCached(cacheKey, run.input.resumeFromRunId)
    if (cached !== undefined) {
      const replayed: WorkflowTaskResult = { ...cached, taskId, origin: 'replayed-from-cache' }
      const task: TrackedTask = {
        id: taskId, sequence: run.taskSequence, input, startedAt: cached.startedAt, status: cached.status,
        result: replayed, promise: Promise.resolve(replayed), origin: 'replayed-from-cache', ...(phase === undefined ? {} : { phase }),
        resolve: () => {}, reject: () => {}, ready: Promise.resolve(), resolveReady: () => {}, rejectReady: () => {}, nativeStarted: false, terminalPublished: true,
      }
      run.tasks.set(taskId, task)
      this.emit(run, 'cache-hit', { taskId, cacheKey, fromRunId: run.input.resumeFromRunId })
      return { taskId, name: input.name }
    }
    let resolve!: (value: WorkflowTaskResult) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<WorkflowTaskResult>((resolve_, reject_) => { resolve = resolve_; reject = reject_ })
    let resolveReady!: () => void
    let rejectReady!: (error: unknown) => void
    const ready = new Promise<void>((resolve_, reject_) => { resolveReady = resolve_; rejectReady = reject_ })
    void promise.catch(() => undefined)
    void ready.catch(() => undefined)
    const task: TrackedTask = { id: taskId, sequence: run.taskSequence, input, startedAt: this.now(), status: 'running', promise, resolve, reject, ready, resolveReady, rejectReady, nativeStarted: false, terminalPublished: false, origin: 'executed', ...(phase === undefined ? {} : { phase }) }
    run.tasks.set(taskId, task)
    run.snapshot = { ...run.snapshot, totalSpawned: run.snapshot.totalSpawned + 1 }
    void this.driveTask(run, semaphore, task, phase, cacheKey)
    await task.ready
    return { taskId, name: input.name }
  }

  private async driveTask(run: MutableRun, semaphore: WorkflowSemaphore, task: TrackedTask, phase: string | undefined, cacheKey: string): Promise<void> {
    let releaseRun: (() => void) | undefined
    let releaseDeployment: (() => void) | undefined
    let isolation: Awaited<ReturnType<WorktreeIsolationAdapter['prepare']>> | undefined
    let allocation = 0
    let reservationActive = false
    let accountedUsage = 0
    let terminalDraft: WorkflowTaskResult | undefined
    try {
      await this.waitAdmission(run)
      releaseRun = await semaphore.acquire(run.controller.signal)
      releaseDeployment = await this.deps.deploymentSemaphore?.acquire(run.controller.signal)
      // A task may have queued on the semaphore before the run was paused.
      // Re-check after admission so queued work cannot slip through the pause gate.
      await this.waitAdmission(run)
      run.active += 1
      run.peakConcurrency = Math.max(run.peakConcurrency, run.active)
      run.snapshot = { ...run.snapshot, activeAgents: run.active }
      const admission = validateWorkflowTaskAdmission(task.input, {
        manifest: run.input.module.manifest, config: this.deps.config, totalSpawned: Math.max(0, run.snapshot.totalSpawned - 1),
        subagents: this.deps.subagents, dispatchAvailable: this.deps.dispatch !== undefined, isolationAvailable: this.deps.isolation !== undefined,
      })
      const { readOnly, route, subagentProvider } = admission
      allocation = admission.allocation
      const total = run.input.module.manifest.tokenBudget
      if (total !== undefined) {
        if (allocation <= 0) throw new WorkflowControlError('token-budgeted workflow task requires maxTokens through its task or model tier')
        if (run.spentTokens + run.reservedTokens + allocation > total) throw new WorkflowControlError('workflow token budget exceeded before agent start')
        run.reservedTokens += allocation
        reservationActive = true
      }
      const descriptor = this.deps.subagents.getProvider(subagentProvider)!
      const verification = task.input.verification ?? (readOnly ? undefined : { enforcement: 'warn' as const, requiresMutation: true, rejectPreparatoryFinalText: true })
      let parent = run.input.parent
      if (task.input.isolation === 'worktree') {
        isolation = await this.deps.isolation!.prepare({ runId: run.snapshot.runId, taskId: task.id, cwd: cwdOf(parent), parent })
        parent = isolation.parent
      }
      const workspaceBefore = verification?.requiresMutation === true || (verification?.requiredChangedPaths?.length ?? 0) > 0
        ? await gitWorkspaceState(cwdOf(parent), verification?.requiredChangedPaths)
        : undefined
      if (verification !== undefined) {
        const cwd = cwdOf(parent)
        const missing = (verification.requiredReadPaths ?? []).filter(path => !existsSync(isAbsolute(path) ? path : resolve(cwd, path))).map(path => `required read path does not exist: ${path}`)
        const adapted = this.deps.verification === undefined ? undefined : await this.deps.verification.preflight(cwd, verification)
        const checked = verificationResult(adapted, verification.enforcement ?? 'hard')
        const violations = [...missing, ...checked.reasons]
        if (violations.length > 0 && verification.enforcement !== 'warn') {
          throw new WorkflowControlError(`agent verification preflight failed: ${violations.join('; ')}`)
        }
        if (violations.length > 0) task.preflightWarnings = violations
      }
      const prompt = this.taskPrompt(task.input, isolation?.cwd)
      const modelProvider = task.input.provider ?? route.provider
      const model = task.input.model ?? route.model
      const request: SubagentStartRequest = {
        label: task.input.name,
        prompt: [{ type: 'text', text: prompt }],
        parent,
        signal: run.controller.signal,
        agentOptions: {
          ...(modelProvider === undefined ? {} : { provider: modelProvider }),
          ...(model === undefined ? {} : { model }),
          ...(allocation <= 0 ? {} : { maxTokens: allocation }),
        },
        ...(readOnly ? { toolFilter: resolveReadOnlyToolFilter(parent, this.deps.config.readOnlyAllowedTools, this.deps.config.readOnlyToolFilter.deny) } : {}),
        ...(task.input.outputSchema === undefined ? {} : { outputSchema: task.input.outputSchema }),
      }
      const dispatched = task.input.target !== undefined || task.input.effort !== undefined
        ? await this.deps.dispatch!.start({
          ...(task.input.target === undefined ? {} : { target: task.input.target }),
          ...(task.input.effort === undefined ? {} : { effort: task.input.effort }),
          provider: subagentProvider, request, subagents: this.deps.subagents,
        })
        : await this.deps.subagents.start(subagentProvider, request)
      const childRun = isDispatchEnvelope(dispatched) ? dispatched.run : dispatched
      const dispatchTelemetry = isDispatchEnvelope(dispatched) ? dispatched.telemetry : undefined
      task.run = childRun
      task.childId = childRun.id
      const taskPhase = task.input.phase ?? phase
      this.emit(run, 'agent-started', { taskId: task.id, name: task.input.name, ...(taskPhase === undefined ? {} : { phase: taskPhase }), childId: childRun.id, provider: subagentProvider })
      appendNative(run.nativeSession, 'tool-workflow/agent-start', {
        runId: WorkflowRunId(run.snapshot.runId), seq: task.sequence, label: task.input.name,
        ...(taskPhase === undefined ? {} : { phase: taskPhase }), childId: childRun.id,
      })
      task.nativeStarted = true
      task.resolveReady()
      const outcome = await childRun.result
      const endedAt = this.now()
      let telemetry: WorkflowDispatchTelemetry | undefined
      try { telemetry = await dispatchTelemetry } catch { /* optional telemetry cannot fail completed work */ }
      let measuredUsage = usageOf(childRun.localAgent) ?? telemetry?.usage
      let usage = measuredUsage?.totalTokens ?? 0
      if (total !== undefined) { run.reservedTokens -= allocation; reservationActive = false; run.spentTokens += usage }
      else run.spentTokens += usage
      accountedUsage = usage
      const finalText = textOf(outcome)
      const initialStatus: WorkflowTaskResult['status'] = outcome.stopReason === 'completed' ? 'completed' : outcome.stopReason === 'aborted' || run.controller.signal.aborted ? 'stopped' : 'failed'
      let status = initialStatus
      let stopReason: string = outcome.stopReason
      let structured = outcome.structured
      if (status !== 'stopped' && task.input.outputSchema !== undefined) {
        const rc2MissingCapture = outcome.stopReason === 'error'
          && outcome.structured === undefined
          && childRecordedCompleted(childRun.localAgent)
        const first = structuredEvaluation(structured, finalText, task.input.outputSchema)
        structured = first.errors.length === 0 ? first.value : undefined
        let repairErrors = first.errors
        let repairSucceeded = false
        if (((initialStatus === 'completed' && first.errors.length > 0) || rc2MissingCapture) && finalText.trim().length > 0 && !run.controller.signal.aborted) {
          const repairController = new AbortController()
          const forwardAbort = (): void => repairController.abort(run.controller.signal.reason)
          run.controller.signal.addEventListener('abort', forwardAbort, { once: true })
          const timer = setTimeout(() => repairController.abort('structured output repair timed out'), 15_000)
          timer.unref()
          let repairRun: SubagentRun | undefined
          try {
            const repairRequest: SubagentStartRequest = {
              label: `${task.input.name} structured repair`,
              prompt: [{ type: 'text', text: [
                'Re-format the completed report as the JSON object required by the workflow.',
                'Do not investigate or use tools. Return only the JSON object.',
                `Validation problems:\n${(first.errors.length === 0 ? ['native structured capture was missing'] : first.errors).map(error => `- ${error}`).join('\n')}`,
                `Schema:\n${JSON.stringify(task.input.outputSchema)}`,
                `Completed report:\n${finalText}`,
              ].join('\n\n') }],
              parent,
              signal: repairController.signal,
              ...(request.agentOptions === undefined ? {} : { agentOptions: request.agentOptions }),
              toolFilter: { allow: [] },
              outputSchema: task.input.outputSchema,
            }
            const repairDispatch = task.input.target !== undefined || task.input.effort !== undefined
              ? await this.deps.dispatch!.start({
                ...(task.input.target === undefined ? {} : { target: task.input.target }),
                ...(task.input.effort === undefined ? {} : { effort: task.input.effort }),
                provider: subagentProvider, request: repairRequest, subagents: this.deps.subagents,
              })
              : await this.deps.subagents.start(subagentProvider, repairRequest)
            repairRun = isDispatchEnvelope(repairDispatch) ? repairDispatch.run : repairDispatch
            const repairedOutcome = await Promise.race([
              repairRun.result,
              new Promise<never>((_resolve, reject) => repairController.signal.addEventListener('abort', () => reject(new Error('structured output repair timed out')), { once: true })),
            ])
            const repaired = structuredEvaluation(repairedOutcome.structured, textOf(repairedOutcome), task.input.outputSchema)
            repairSucceeded = repairedOutcome.stopReason === 'completed' && repaired.errors.length === 0
            structured = repairSucceeded ? repaired.value : undefined
            repairErrors = repairedOutcome.stopReason === 'completed' ? repaired.errors : [`structured repair child stopped with ${repairedOutcome.stopReason}`]
            measuredUsage = addUsage(measuredUsage, usageOf(repairRun.localAgent))
            usage = measuredUsage?.totalTokens ?? usage
          } catch (error) {
            structured = undefined
            repairErrors = [message(error)]
          } finally {
            clearTimeout(timer)
            run.controller.signal.removeEventListener('abort', forwardAbort)
            await repairRun?.dispose()
          }
        }
        if (structured === undefined && (initialStatus === 'completed' || rc2MissingCapture)) {
          status = 'failed'
          stopReason = `structured output validation failed${repairErrors.length === 0 ? '' : `: ${repairErrors.join('; ')}`}`
        } else if (rc2MissingCapture && repairSucceeded) {
          // DSH rc.2 reports an otherwise-completed child as "error" when its
          // native structured capture is missing. A valid, bounded repair is
          // the authoritative terminal result for that specific host shape.
          status = 'completed'
          stopReason = 'completed-after-structured-repair'
        }
      }
      if (usage !== accountedUsage) {
        run.spentTokens += usage - accountedUsage
        accountedUsage = usage
        if (total !== undefined && run.spentTokens > total) throw new WorkflowControlError('workflow token budget exceeded during structured output repair')
      }
      let warnings: readonly string[] | undefined = task.preflightWarnings
      const requestedTier = task.input.modelHint ?? 'inherited'
      const explicitSelector = task.input.provider !== undefined || task.input.model !== undefined
      const tierOutcome: NonNullable<WorkflowTaskResult['tierOutcome']> = task.input.modelHint === undefined
        ? 'inherited'
        : explicitSelector
          ? 'shadowed-by-selector'
          : task.input.modelHint === 'balanced'
            ? 'balanced-parent'
            : task.input.modelHint === 'fast' && !readOnly
              ? 'fast-write-ineligible'
              : 'applied'
      const routedByTier = tierOutcome === 'applied'
      let draft: WorkflowTaskResult = {
        taskId: task.id, name: task.input.name, status, finalText,
        ...(structured === undefined ? {} : { structured }),
        childId: childRun.id, stopReason,
        startedAt: task.startedAt, endedAt,
        ...(measuredUsage === undefined ? {} : { tokenUsage: usage }),
        ...(measuredUsage === undefined ? {} : { usage: measuredUsage }),
        provider: telemetry?.provider ?? modelProvider ?? subagentProvider,
        subagentProvider,
        ...((telemetry?.model ?? model) === undefined ? {} : { model: telemetry?.model ?? model }),
        requestedTier, tierOutcome,
        providerSource: task.input.provider !== undefined ? 'explicit' : routedByTier && route.provider !== undefined ? 'tier' : modelProvider === undefined ? 'default' : 'parent',
        ...(task.input.model !== undefined ? { modelSource: 'explicit' as const } : routedByTier && route.model !== undefined ? { modelSource: 'tier' as const } : model === undefined ? {} : { modelSource: 'parent' as const }),
        ...((telemetry?.initialProvider ?? modelProvider ?? subagentProvider) === undefined ? {} : { initialProvider: telemetry?.initialProvider ?? modelProvider ?? subagentProvider }),
        ...((telemetry?.initialModel ?? model) === undefined ? {} : { initialModel: telemetry?.initialModel ?? model }),
        ...((telemetry?.finalProvider ?? telemetry?.provider ?? modelProvider ?? subagentProvider) === undefined ? {} : { finalProvider: telemetry?.finalProvider ?? telemetry?.provider ?? modelProvider ?? subagentProvider }),
        ...((telemetry?.finalModel ?? telemetry?.model ?? model) === undefined ? {} : { finalModel: telemetry?.finalModel ?? telemetry?.model ?? model }),
        ...(telemetry?.fallbackReason === undefined ? {} : { fallbackReason: telemetry.fallbackReason }),
        ...((telemetry?.resolvedEffort ?? task.input.effort) === undefined ? {} : { resolvedEffort: telemetry?.resolvedEffort ?? task.input.effort }),
        ...(telemetry?.iterations === undefined ? {} : { iterations: telemetry.iterations }),
        ...(telemetry?.durationMs === undefined ? {} : { durationMs: telemetry.durationMs }),
        artifacts: [], origin: 'executed',
        ...(outcome.stopReason === 'max-tokens' ? { limitReached: true } : {}),
      }
      terminalDraft = draft
      let verificationEvidence: WorkflowTaskVerificationResult | undefined
      if (status === 'completed' && verification !== undefined) {
        const cwd = cwdOf(parent)
        for (let attempt = 0; attempt <= 2; attempt += 1) {
          const observed = observedToolEvidence(childRun.localAgent)
          const workspaceAfter = verification.requiresMutation === true || (verification.requiredChangedPaths?.length ?? 0) > 0
            ? await gitWorkspaceState(cwd, verification.requiredChangedPaths)
            : undefined
          const workspaceChanged = workspaceBefore !== undefined && workspaceAfter !== undefined && workspaceBefore.fingerprint !== workspaceAfter.fingerprint
          const adapted = this.deps.verification === undefined ? undefined : await this.deps.verification.verify(cwd, task.input, draft)
          const checked = verificationResult(adapted, verification.enforcement ?? 'hard')
          const reasons: string[] = []
          for (const required of verification.requiredReadPaths ?? []) if (!pathObserved(required, observed.readPaths, cwd)) reasons.push(`required path was not read: ${required}`)
          const adapterMutation = checked.mutationEvidence === true
          const mutationEvidence = adapterMutation || (observed.mutationToolCalls.length > 0 && workspaceChanged)
          if (verification.requiresMutation === true && !mutationEvidence) reasons.push(workspaceBefore === undefined || workspaceAfter === undefined ? 'workspace mutation evidence is unavailable' : observed.mutationToolCalls.length === 0 ? 'no successful mutation tool call was observed' : 'successful mutation tools produced no workspace change')
          const changedPaths = new Set(checked.changedPaths ?? [])
          for (const required of verification.requiredChangedPaths ?? []) {
            const target = workspacePath(cwd, required)
            const normalized = target?.normalized.toLowerCase()
            const changedByAdapter = [...changedPaths].some(path => path.replaceAll('\\', '/').toLowerCase() === normalized)
            const changedByWorkspace = normalized !== undefined
              && workspaceBefore?.requiredPathFingerprints[normalized] !== undefined
              && workspaceAfter?.requiredPathFingerprints[normalized] !== undefined
              && workspaceBefore.requiredPathFingerprints[normalized] !== workspaceAfter.requiredPathFingerprints[normalized]
            if (changedByWorkspace) changedPaths.add(target!.normalized)
            if (!changedByAdapter && !changedByWorkspace) reasons.push(`required path was not changed: ${required}`)
          }
          if (verification.minFinalTextChars !== undefined && draft.finalText.trim().length < verification.minFinalTextChars) reasons.push(`final text is shorter than ${verification.minFinalTextChars} characters`)
          if (verification.rejectPreparatoryFinalText === true && /\b(?:i will|i'll|next i|准备|接下来我会)\b/iu.test(draft.finalText.trim())) reasons.push('final text is preparatory rather than completed work')
          reasons.push(...checked.reasons)
          verificationEvidence = {
            ...checked, ok: reasons.length === 0, reasons,
            enforcement: verification.enforcement ?? 'hard',
            changedPaths: [...changedPaths],
            readPaths: [...new Set([...(checked.readPaths ?? []), ...observed.readPaths])],
            mutationToolCalls: [...new Set([...(checked.mutationToolCalls ?? []), ...observed.mutationToolCalls])],
            mutationEvidence,
          }
          if (reasons.length === 0 || verification.enforcement === 'warn') break
          if (attempt === 2 || childRun.localAgent === undefined) throw new Error(`agent verification failed: ${reasons.join('; ')}`)
          childRun.localAgent.followup(createUserMessage({
            content: [{ type: 'text', text: `Verification failed. Repair the same task, then provide a complete final result.\n${reasons.map(reason => `- ${reason}`).join('\n')}` }],
            source: { kind: 'plugin', plugin: '@dsh-external/workflow', form: 'relay' },
          }))
          await childRun.localAgent.whenIdle()
          draft = { ...draft, finalText: latestAssistantText(childRun.localAgent, draft.finalText) }
          terminalDraft = draft
        }
        const repairedUsage = usageOf(childRun.localAgent)
        if (repairedUsage !== undefined && repairedUsage.totalTokens !== usage) {
          run.spentTokens += repairedUsage.totalTokens - usage
          usage = repairedUsage.totalTokens
          accountedUsage = usage
          measuredUsage = repairedUsage
          draft = { ...draft, tokenUsage: usage, usage: repairedUsage }
          terminalDraft = draft
          if (total !== undefined && run.spentTokens > total) throw new WorkflowControlError('workflow token budget exceeded during verification repair')
        }
        warnings = [...(warnings ?? []), ...(verificationEvidence?.reasons ?? [])]
        if (verificationEvidence !== undefined && (task.preflightWarnings?.length ?? 0) > 0) {
          verificationEvidence = { ...verificationEvidence, ok: false, reasons: [...task.preflightWarnings!, ...verificationEvidence.reasons] }
        }
      }
      const verifiedStatus = status === 'completed' && (warnings?.length ?? 0) > 0 ? 'completed_unverified' : status
      task.status = verifiedStatus
      task.result = {
        ...draft, status: verifiedStatus,
        ...(verificationEvidence === undefined ? {} : { verification: verificationEvidence }),
        ...(warnings === undefined || warnings.length === 0 ? {} : { verificationWarnings: warnings }),
      }
      if (task.result.status === 'completed' && (warnings === undefined || warnings.length === 0)) run.writer.setCached(cacheKey, task.result)
      this.emit(run, 'agent-completed', { taskId: task.id, outcome: status, childId: childRun.id })
      appendNative(run.nativeSession, 'tool-workflow/agent-end', { runId: WorkflowRunId(run.snapshot.runId), seq: task.sequence, outcome: status === 'completed' ? 'completed' : status === 'stopped' ? 'cancelled' : 'failed' })
      task.terminalPublished = true
      task.resolve(task.result)
    } catch (error) {
      if (reservationActive) run.reservedTokens = Math.max(0, run.reservedTokens - allocation)
      task.status = run.controller.signal.aborted ? 'stopped' : 'failed'
      if (!task.nativeStarted) task.rejectReady(error)
      if (!task.terminalPublished) {
        this.emit(run, 'agent-completed', { taskId: task.id, outcome: task.status, error: message(error), ...(task.childId === undefined ? {} : { childId: task.childId }) })
        if (task.nativeStarted) appendNative(run.nativeSession, 'tool-workflow/agent-end', { runId: WorkflowRunId(run.snapshot.runId), seq: task.sequence, outcome: task.status === 'stopped' ? 'cancelled' : 'failed' })
        task.terminalPublished = true
      }
      task.result = {
        ...(terminalDraft ?? {
          taskId: task.id, name: task.input.name, finalText: '',
          ...(task.childId === undefined ? {} : { childId: task.childId }),
          startedAt: task.startedAt, artifacts: [], origin: 'executed' as const,
        }),
        status: task.status, stopReason: message(error), endedAt: this.now(),
        ...(task.input.verification === undefined ? {} : { verification: { ok: false, reasons: [message(error)], enforcement: task.input.verification.enforcement ?? 'hard' } }),
      }
      if (task.nativeStarted && task.result !== undefined) {
        const previous = task.result
        const measured = usageOf(task.run?.localAgent)
        if (measured !== undefined && measured.totalTokens !== accountedUsage) {
          run.spentTokens += measured.totalTokens - accountedUsage
          accountedUsage = measured.totalTokens
        }
        task.result = {
          ...previous,
          finalText: latestAssistantText(task.run?.localAgent, previous.finalText),
          ...(measured === undefined ? {} : { tokenUsage: measured.totalTokens, usage: measured }),
        }
      }
      if (task.nativeStarted) task.resolve(task.result)
      else task.reject(error)
    } finally {
      try { await task.run?.dispose() } finally {
        await isolation?.dispose()
        if (releaseRun !== undefined) {
          run.active -= 1
          run.snapshot = { ...run.snapshot, activeAgents: run.active }
          releaseDeployment?.()
          releaseRun()
        }
      }
    }
  }

  private taskPrompt(input: WorkflowSpawnAgentInput, cwd?: string): string {
    const sections = [input.prompt]
    if (input.scopeSummary !== undefined) sections.push(`Scope: ${input.scopeSummary}`)
    if (input.constraints !== undefined) sections.push(`Constraints:\n${input.constraints.map(item => `- ${item}`).join('\n')}`)
    if (input.evidenceRefs !== undefined) sections.push(`Evidence references:\n${input.evidenceRefs.map(item => `- ${item}`).join('\n')}`)
    if (cwd !== undefined) sections.push(`Isolated workspace: ${cwd}`)
    if (input.terseResult === true) sections.push('Return only a terse final result.')
    return sections.join('\n\n')
  }

  private expectTask(run: MutableRun, taskId: string): TrackedTask {
    const task = run.tasks.get(taskId)
    if (task === undefined) throw new Error(`workflow task "${taskId}" was not found in run ${run.snapshot.runId}`)
    return task
  }

  private taskSnapshot(run: MutableRun, taskId: string): WorkflowTaskSnapshot {
    const task = this.expectTask(run, taskId)
    const phaseName = task.input.phase ?? task.phase
    const phaseNames = [...new Set([
      ...run.input.module.manifest.phases,
      ...[...run.tasks.values()].flatMap(item => item.input.phase ?? item.phase ?? []),
    ])]
    const liveText = latestAssistantText(task.run?.localAgent, task.result?.finalText ?? '')
    return {
      taskId, name: task.input.name, status: task.status,
      ...(task.input.phase === undefined ? {} : { phase: task.input.phase }),
      ...(task.childId === undefined ? {} : { childId: task.childId }),
      ...(phaseName === undefined ? {} : { phaseId: `phase:${phaseNames.indexOf(phaseName) + 1}` }),
      ...(task.childId === undefined ? {} : { childAgentId: task.childId }),
      ...(liveText.length === 0 ? {} : { lastText: liveText }),
      ...(task.result?.finalText === undefined ? {} : { finalText: task.result.finalText }),
      ...(task.result?.structured === undefined ? {} : { structured: task.result.structured }),
      startedAt: task.startedAt,
      ...(task.result?.endedAt === undefined ? {} : { endedAt: task.result.endedAt }),
    }
  }

  private async waitTask(run: MutableRun, taskId: string, timeoutMs?: number): Promise<WorkflowTaskResult> {
    const task = this.expectTask(run, taskId)
    if (timeoutMs === undefined) return await task.promise
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('workflow wait timeout must be positive')
    return await Promise.race([
      task.promise,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`workflow task "${taskId}" wait timed out after ${timeoutMs}ms`)), timeoutMs)
        timer.unref()
      }),
    ])
  }
}

export function snapshotCapsule(module: WorkflowStartInput['module'], config: ResolvedWorkflowConfig): WorkflowCapsule | undefined {
  if (module.source === undefined) return undefined
  return module.capsule ?? createWorkflowCapsule({
    minDshVersion: config.dshVersion,
    manifest: module.manifest,
    source: module.source,
    provenance: { createdAt: new Date().toISOString(), dshVersion: config.dshVersion, pluginVersion: config.pluginVersion },
  })
}
