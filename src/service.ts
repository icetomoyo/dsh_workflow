import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import { authorWorkflowCapsule, type WorkflowSmokeAdmissionOptions } from './author.js'
import { listBuiltinWorkflows, listWorkflowPatterns } from './builtins.js'
import {
  deleteSavedWorkflow, discoverWorkflowCatalog, loadWorkflowByName, renameSavedWorkflow, saveWorkflowCapsule,
  type LoadedWorkflow, type WorkflowCatalog, type WorkflowCatalogOptions,
} from './catalog.js'
import { DynamicWorkflowEngine, WorkflowSemaphore, snapshotCapsule } from './engine.js'
import { WorkflowRunStore, type WorkflowPruneOptions, type WorkflowPruneResult } from './store.js'
import type {
  ResolvedWorkflowConfig, WorkflowCapsule, WorkflowModule, WorkflowRun, WorkflowRunSnapshot,
  WorkflowDispatchAdapter, WorkflowEvent, WorkflowSource, WorkflowVerificationAdapter, WorktreeIsolationAdapter,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dynamicWorkflows: DynamicWorkflowService
  }
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    workflow: 'workflow'
  }
}

export interface DynamicWorkflowServiceOptions {
  readonly config: ResolvedWorkflowConfig
  readonly subagents: SubagentRuntime
  readonly approval?: ApprovalService
  readonly jobs?: JobRegistry
  readonly userQuestions?: UserQuestionService
  readonly verification?: WorkflowVerificationAdapter
  readonly isolation?: WorktreeIsolationAdapter
  readonly dispatch?: WorkflowDispatchAdapter
}

function canonicalProjectDirectory(cwd: string): string {
  const absolute = resolve(cwd)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function projectPartitionKey(cwd: string): string {
  return createHash('sha256').update(canonicalProjectDirectory(cwd)).digest('hex')
}

function cwdOf(agent: Agent): string {
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new Error('workflow requires a parent session with an absolute cwd')
  return cwd
}

function terminalOutput(snapshot: WorkflowRunSnapshot): string {
  return JSON.stringify({ runId: snapshot.runId, status: snapshot.status, resultSummary: snapshot.resultSummary, error: snapshot.error })
}

export class DynamicWorkflowService extends Service {
  private readonly engines = new Map<string, DynamicWorkflowEngine>()
  private readonly stores = new Map<string, WorkflowRunStore>()
  private verification: WorkflowVerificationAdapter | undefined
  private isolation: WorktreeIsolationAdapter | undefined
  private readonly deploymentSemaphore: WorkflowSemaphore
  private dispatch: WorkflowDispatchAdapter | undefined

  constructor(ctx: Context, private readonly options: DynamicWorkflowServiceOptions) {
    super(ctx, 'dynamicWorkflows')
    this.verification = options.verification
    this.isolation = options.isolation
    this.deploymentSemaphore = new WorkflowSemaphore(options.config.maxConcurrency)
    this.dispatch = options.dispatch
    ctx.effect(() => async () => { await this.disposeAll() }, 'dynamic-workflows: stop active runs')
  }

  registerVerificationAdapter(adapter: WorkflowVerificationAdapter): () => void {
    if (this.engines.size > 0) throw new Error('workflow verification adapters must be registered before the first workflow operation')
    if (this.verification !== undefined) throw new Error('a workflow verification adapter is already registered')
    this.verification = adapter
    return () => { if (this.engines.size === 0 && this.verification === adapter) this.verification = undefined }
  }

  registerIsolationAdapter(adapter: WorktreeIsolationAdapter): () => void {
    if (this.engines.size > 0) throw new Error('workflow isolation adapters must be registered before the first workflow operation')
    if (this.isolation !== undefined) throw new Error('a workflow isolation adapter is already registered')
    this.isolation = adapter
    return () => { if (this.engines.size === 0 && this.isolation === adapter) this.isolation = undefined }
  }

  registerDispatchAdapter(adapter: WorkflowDispatchAdapter): () => void {
    if (this.engines.size > 0) throw new Error('workflow dispatch adapters must be registered before the first workflow operation')
    if (this.dispatch !== undefined) throw new Error('a workflow dispatch adapter is already registered')
    this.dispatch = adapter
    return () => { if (this.engines.size === 0 && this.dispatch === adapter) this.dispatch = undefined }
  }

  taskAdmissionServices(agent: Agent): WorkflowSmokeAdmissionOptions {
    return {
      subagents: this.options.subagents,
      dispatchAvailable: this.dispatch !== undefined,
      isolationAvailable: this.isolation !== undefined,
      resolveNested: async name => ({ module: (await this.load(agent, name)).module }),
    }
  }

  async list(agent: Agent): Promise<WorkflowCatalog> {
    return await discoverWorkflowCatalog(this.catalogOptions(agent))
  }

  async load(agent: Agent, name: string, trusted = false): Promise<LoadedWorkflow> {
    return await loadWorkflowByName(this.catalogOptions(agent), name, trusted)
  }

  async startNamed(agent: Agent, name: string, args?: unknown, signal?: AbortSignal, approvalGranted = false): Promise<WorkflowRun> {
    let loaded: LoadedWorkflow
    let approved = approvalGranted
    try { loaded = await this.load(agent, name, false) } catch (error) {
      if (!/trusted-local/u.test(error instanceof Error ? error.message : String(error))) throw error
      if (!approved) {
        const granted = await this.confirm(agent, `Run trusted local workflow "${name}"?`, 'This executes local TypeScript/JavaScript with host authority.', signal)
        if (!granted) throw new Error('trusted-local workflow was not approved')
        approved = true
      }
      loaded = await this.load(agent, name, true)
    }
    return await this.startLoaded(agent, loaded, args, signal, approved)
  }

  async startInline(agent: Agent, module: WorkflowModule, args?: unknown, signal?: AbortSignal, source: WorkflowSource = 'inline', approvalGranted = false): Promise<WorkflowRun> {
    const capsule = snapshotCapsule(module, this.options.config)
    const withSnapshot: WorkflowModule = { ...module, ...(capsule === undefined ? {} : { capsule }) }
    return await this.engine(agent).start({ module: withSnapshot, source, parent: agent, args, ...(signal === undefined ? {} : { signal }), ...(approvalGranted ? { requireApproval: false } : {}) })
  }

  async create(agent: Agent, request: string, signal: AbortSignal, save?: { readonly scope: 'project' | 'personal'; readonly replace?: boolean }): Promise<{ readonly capsule: WorkflowCapsule; readonly warnings: readonly string[]; readonly path?: string }> {
    const authored = await authorWorkflowCapsule({ request, parent: agent, subagents: this.options.subagents, config: this.options.config, signal })
    let path: string | undefined
    if (save !== undefined) path = await saveWorkflowCapsule(this.catalogDirectory(agent, save.scope), authored.capsule.manifest.name, authored.capsule, save.replace)
    return { ...authored, ...(path === undefined ? {} : { path }) }
  }

  async revise(agent: Agent, name: string, change: string, signal: AbortSignal, replace = false): Promise<{ readonly capsule: WorkflowCapsule; readonly warnings: readonly string[]; readonly path: string }> {
    let capsule: WorkflowCapsule | undefined
    let scope: 'project' | 'personal' = 'project'
    let fromRunId: string | undefined
    try {
      const loaded = await this.load(agent, name)
      if (loaded.capsule !== undefined && (loaded.source === 'project' || loaded.source === 'personal')) {
        capsule = loaded.capsule
        scope = loaded.source
      }
    } catch (error) {
      if (!/not found/u.test(error instanceof Error ? error.message : String(error))) throw error
    }
    if (capsule === undefined) {
      const identity = this.store(agent).resolveIdentity(name)
      if (identity.kind !== 'run') throw new Error('revise requires a saved workflow or generated run identity')
      capsule = this.store(agent).getCapsule(identity.runId)
      fromRunId = identity.runId
    }
    if (capsule === undefined) throw new Error('revise requires a generated workflow capsule')
    const authored = await authorWorkflowCapsule({ request: capsule.intent?.originalRequest ?? capsule.manifest.description, parent: agent, subagents: this.options.subagents, config: this.options.config, signal, existing: capsule, change, ...(fromRunId === undefined ? {} : { fromRunId }) })
    const directory = this.catalogDirectory(agent, scope)
    const path = await saveWorkflowCapsule(directory, authored.capsule.manifest.name, authored.capsule, replace)
    return { ...authored, path }
  }

  runs(agent: Agent): readonly WorkflowRunSnapshot[] { return this.engine(agent).list() }
  show(agent: Agent, runId: string): WorkflowRunSnapshot | undefined { return this.engine(agent).get(runId) }
  events(agent: Agent, runId: string): readonly WorkflowEvent[] { return this.store(agent).getEvents(runId) }
  pause(agent: Agent, runId: string): boolean { return this.engine(agent).pause(runId) }
  resume(agent: Agent, runId: string): boolean { return this.engine(agent).resume(runId) }
  stop(agent: Agent, runId: string, reason?: string): boolean { return this.engine(agent).stop(runId, reason) }
  subscribe(agent: Agent, listener: (event: WorkflowEvent, snapshot: WorkflowRunSnapshot) => void): () => void { return this.engine(agent).subscribe(listener) }
  renameRun(agent: Agent, runId: string, displayName: string): WorkflowRunSnapshot { return this.store(agent).rename(runId, displayName) }
  deleteRun(agent: Agent, runId: string, force = false): void {
    if (this.engine(agent).isActive(runId)) throw new Error(`workflow run "${runId}" is active and cannot be deleted`)
    this.store(agent).delete(runId, force)
  }
  prune(agent: Agent, options: WorkflowPruneOptions): WorkflowPruneResult { return this.store(agent).prune(options) }

  async rerun(agent: Agent, target: string, args: unknown, signal?: AbortSignal, resume = false, approvalGranted = false): Promise<WorkflowRun> {
    const identity = this.store(agent).resolveIdentity(target)
    if (identity.kind === 'ambiguous') throw new Error(`workflow target "${target}" matches multiple runs: ${identity.runIds.join(', ')}`)
    const catalogEntry = (await this.list(agent)).entries.find(entry => entry.name === target && entry.valid)
    if (identity.kind === 'run' && catalogEntry !== undefined) throw new Error(`workflow target "${target}" is ambiguous between a run and saved workflow`)
    let loadedSaved: LoadedWorkflow | undefined
    try { loadedSaved = await this.load(agent, target, approvalGranted) } catch (error) {
      if (/trusted-local/u.test(error instanceof Error ? error.message : String(error))) {
        const granted = await this.confirm(agent, `Run trusted local workflow "${target}"?`, 'This executes local TypeScript/JavaScript with host authority.', signal)
        if (!granted) throw new Error('trusted-local workflow was not approved')
        loadedSaved = await this.load(agent, target, true)
        approvalGranted = true
      }
      // A missing saved workflow may still identify an immutable run snapshot.
      else if (!/not found/u.test(error instanceof Error ? error.message : String(error))) throw error
    }
    if (loadedSaved !== undefined) return await this.startLoaded(agent, loadedSaved, args, signal, approvalGranted)
    if (identity.kind === 'missing') throw new Error(`workflow target "${target}" was not found`)
    const capsule = this.store(agent).getCapsule(identity.runId)
    if (capsule === undefined) throw new Error(`run "${identity.runId}" has no immutable capability script snapshot`)
    const module: WorkflowModule = { manifest: capsule.manifest, execution: 'capability-generated', source: capsule.source, capsule }
    return await this.engine(agent).start({ module, source: 'run-snapshot', parent: agent, args, ...(signal === undefined ? {} : { signal }), sourceRunId: identity.runId, ...(resume ? { resumeFromRunId: identity.runId } : {}), ...(approvalGranted ? { requireApproval: false } : {}) })
  }

  async saveRun(agent: Agent, runId: string, name: string, scope: 'project' | 'personal', replace = false): Promise<string> {
    const capsule = this.store(agent).getCapsule(runId)
    if (capsule === undefined) throw new Error(`run "${runId}" has no generated capsule snapshot`)
    const saved: WorkflowCapsule = {
      ...capsule,
      manifest: { ...capsule.manifest, name },
      provenance: {
        ...(capsule.provenance ?? { createdAt: new Date().toISOString(), dshVersion: this.options.config.dshVersion, pluginVersion: this.options.config.pluginVersion }),
        fromRunId: runId,
        fromWorkflowName: capsule.manifest.name,
      },
    }
    return await saveWorkflowCapsule(this.catalogDirectory(agent, scope), name, saved, replace)
  }

  async renameSaved(agent: Agent, from: string, to: string, scope: 'project' | 'personal'): Promise<string> {
    return await renameSavedWorkflow(this.catalogDirectory(agent, scope), from, to)
  }

  async deleteSaved(agent: Agent, name: string, scope: 'project' | 'personal'): Promise<void> {
    await deleteSavedWorkflow(this.catalogDirectory(agent, scope), name)
  }

  async confirm(agent: Agent, question: string, detail: string, signal?: AbortSignal): Promise<boolean> {
    if (this.options.userQuestions === undefined) throw new Error('workflow confirmation requires a DSH user-questions provider')
    const answer = await this.options.userQuestions.ask({
      agent, ...(signal === undefined ? {} : { signal }),
      questions: [{ id: 'workflow-approval', header: 'Workflow', question, detail, options: [{ label: 'Run', description: 'Approve this workflow once.' }, { label: 'Cancel', description: 'Do not run it.' }] }],
    })
    return answer.answers.some(item => item.id === 'workflow-approval' && item.selected.includes('Run'))
  }

  attachBackgroundJob(agent: Agent, run: WorkflowRun): JobId | undefined {
    const jobs = this.options.jobs
    if (jobs === undefined) return undefined
    try {
      return jobs.start({
        kind: 'workflow', label: run.getSnapshot().workflow, owner: agent,
        run: () => ({
          cancel: reason => { this.stop(agent, run.runId, reason) },
          done: run.done.then(snapshot => ({
            status: snapshot.status === 'completed' ? 'completed' : snapshot.status === 'stopped' ? 'killed' : 'failed',
            detail: snapshot.status,
            output: terminalOutput(snapshot),
          })),
        }),
      })
    } catch (error) {
      this.ctx.logger.warn(`workflow ${run.runId}: DSH background-job registration failed; the durable workflow run remains available through workflow_manage: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled([...this.engines.values()].map(async engine => await engine.disposeAll()))
    this.engines.clear()
    this.stores.clear()
  }

  private async startLoaded(agent: Agent, loaded: LoadedWorkflow, args?: unknown, signal?: AbortSignal, approvalGranted = false): Promise<WorkflowRun> {
    return await this.engine(agent).start({
      module: loaded.module, source: loaded.source, parent: agent, args, ...(signal === undefined ? {} : { signal }),
      ...(loaded.source === 'project' || loaded.source === 'personal' ? { savedWorkflowName: loaded.module.manifest.name } : {}),
      ...(approvalGranted ? { requireApproval: false } : {}),
    })
  }

  private engine(agent: Agent): DynamicWorkflowEngine {
    const cwd = resolve(cwdOf(agent))
    let engine = this.engines.get(cwd)
    if (engine !== undefined) return engine
    engine = new DynamicWorkflowEngine({
      subagents: this.options.subagents,
      config: this.options.config,
      store: this.store(agent),
      ...(this.options.approval === undefined ? {} : { approval: this.options.approval }),
      userInteractionAvailable: this.options.userQuestions !== undefined,
      ...(this.verification === undefined ? {} : { verification: this.verification }),
      ...(this.isolation === undefined ? {} : { isolation: this.isolation }),
      ...(this.dispatch === undefined ? {} : { dispatch: this.dispatch }),
      deploymentSemaphore: this.deploymentSemaphore,
      resolveNested: async name => {
        const loaded = await this.load(agent, name)
        return { module: loaded.module, source: loaded.source }
      },
    })
    this.engines.set(cwd, engine)
    return engine
  }

  private store(agent: Agent): WorkflowRunStore {
    const cwd = resolve(cwdOf(agent))
    let store = this.stores.get(cwd)
    if (store !== undefined) return store
    const configured = this.options.config.runDirectory
    const canonical = canonicalProjectDirectory(cwd)
    const root = isAbsolute(configured) ? join(configured, projectPartitionKey(cwd)) : resolve(cwd, configured)
    store = new WorkflowRunStore(root, undefined, isAbsolute(configured) ? canonical : undefined)
    this.stores.set(cwd, store)
    return store
  }

  private catalogOptions(agent: Agent): WorkflowCatalogOptions {
    return {
      project: this.catalogDirectory(agent, 'project'), personal: this.catalogDirectory(agent, 'personal'),
      maxCapsuleBytes: this.options.config.maxCapsuleBytes, maxEntries: this.options.config.maxCatalogEntries,
      maxAgents: this.options.config.maxAgents, maxConcurrency: this.options.config.maxConcurrency,
      builtins: listBuiltinWorkflows(), patterns: listWorkflowPatterns(),
    }
  }

  private catalogDirectory(agent: Agent, scope: 'project' | 'personal'): string {
    const configured = scope === 'project' ? this.options.config.projectDirectory : this.options.config.personalDirectory
    if (isAbsolute(configured)) return configured
    return scope === 'project' ? resolve(cwdOf(agent), configured) : resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'), configured)
  }
}
