import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs';
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval';
import type { UserQuestionService } from '@deepseek-ai/dsh-user-questions';
import { type WorkflowSmokeAdmissionOptions } from './author.js';
import { type LoadedWorkflow, type WorkflowCatalog } from './catalog.js';
import { type WorkflowPruneOptions, type WorkflowPruneResult } from './store.js';
import type { ResolvedWorkflowConfig, WorkflowCapsule, WorkflowModule, WorkflowRun, WorkflowRunSnapshot, WorkflowDispatchAdapter, WorkflowEvent, WorkflowSource, WorkflowVerificationAdapter, WorktreeIsolationAdapter } from './types.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        dynamicWorkflows: DynamicWorkflowService;
    }
}
declare module '@deepseek-ai/dsh-jobs' {
    interface JobKindMap {
        workflow: 'workflow';
    }
}
export interface DynamicWorkflowServiceOptions {
    readonly config: ResolvedWorkflowConfig;
    readonly subagents: SubagentRuntime;
    readonly approval?: ApprovalService;
    readonly jobs?: JobRegistry;
    readonly userQuestions?: UserQuestionService;
    readonly verification?: WorkflowVerificationAdapter;
    readonly isolation?: WorktreeIsolationAdapter;
    readonly dispatch?: WorkflowDispatchAdapter;
}
export declare function projectPartitionKey(cwd: string): string;
export declare class DynamicWorkflowService extends Service {
    private readonly options;
    private readonly engines;
    private readonly stores;
    private verification;
    private isolation;
    private readonly deploymentSemaphore;
    private dispatch;
    constructor(ctx: Context, options: DynamicWorkflowServiceOptions);
    registerVerificationAdapter(adapter: WorkflowVerificationAdapter): () => void;
    registerIsolationAdapter(adapter: WorktreeIsolationAdapter): () => void;
    registerDispatchAdapter(adapter: WorkflowDispatchAdapter): () => void;
    taskAdmissionServices(agent: Agent): WorkflowSmokeAdmissionOptions;
    list(agent: Agent): Promise<WorkflowCatalog>;
    load(agent: Agent, name: string, trusted?: boolean): Promise<LoadedWorkflow>;
    startNamed(agent: Agent, name: string, args?: unknown, signal?: AbortSignal, approvalGranted?: boolean): Promise<WorkflowRun>;
    startInline(agent: Agent, module: WorkflowModule, args?: unknown, signal?: AbortSignal, source?: WorkflowSource, approvalGranted?: boolean): Promise<WorkflowRun>;
    create(agent: Agent, request: string, signal: AbortSignal, save?: {
        readonly scope: 'project' | 'personal';
        readonly replace?: boolean;
    }): Promise<{
        readonly capsule: WorkflowCapsule;
        readonly warnings: readonly string[];
        readonly path?: string;
    }>;
    revise(agent: Agent, name: string, change: string, signal: AbortSignal, replace?: boolean): Promise<{
        readonly capsule: WorkflowCapsule;
        readonly warnings: readonly string[];
        readonly path: string;
    }>;
    runs(agent: Agent): readonly WorkflowRunSnapshot[];
    show(agent: Agent, runId: string): WorkflowRunSnapshot | undefined;
    events(agent: Agent, runId: string): readonly WorkflowEvent[];
    pause(agent: Agent, runId: string): boolean;
    resume(agent: Agent, runId: string): boolean;
    stop(agent: Agent, runId: string, reason?: string): boolean;
    subscribe(agent: Agent, listener: (event: WorkflowEvent, snapshot: WorkflowRunSnapshot) => void): () => void;
    renameRun(agent: Agent, runId: string, displayName: string): WorkflowRunSnapshot;
    deleteRun(agent: Agent, runId: string, force?: boolean): void;
    prune(agent: Agent, options: WorkflowPruneOptions): WorkflowPruneResult;
    rerun(agent: Agent, target: string, args: unknown, signal?: AbortSignal, resume?: boolean, approvalGranted?: boolean): Promise<WorkflowRun>;
    saveRun(agent: Agent, runId: string, name: string, scope: 'project' | 'personal', replace?: boolean): Promise<string>;
    renameSaved(agent: Agent, from: string, to: string, scope: 'project' | 'personal'): Promise<string>;
    deleteSaved(agent: Agent, name: string, scope: 'project' | 'personal'): Promise<void>;
    confirm(agent: Agent, question: string, detail: string, signal?: AbortSignal): Promise<boolean>;
    attachBackgroundJob(agent: Agent, run: WorkflowRun): JobId | undefined;
    disposeAll(): Promise<void>;
    private startLoaded;
    private engine;
    private store;
    private catalogOptions;
    private catalogDirectory;
}
