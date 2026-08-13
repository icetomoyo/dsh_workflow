import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import { type ToolRestriction } from '@deepseek-ai/dsh-tools';
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval';
import { WorkflowRunStore } from './store.js';
import type { ResolvedWorkflowConfig, WorkflowCapsule, WorkflowEvent, WorkflowModelHint, WorkflowPreflightResult, WorkflowRun, WorkflowManifest, WorkflowRunSnapshot, WorkflowSpawnAgentInput, WorkflowStartInput, WorkflowVerificationAdapter, WorktreeIsolationAdapter, WorkflowDispatchAdapter } from './types.js';
export interface WorkflowEngineDependencies {
    readonly subagents: SubagentRuntime;
    readonly config: ResolvedWorkflowConfig;
    readonly store: WorkflowRunStore;
    readonly approval?: ApprovalService;
    readonly userInteractionAvailable?: boolean;
    readonly verification?: WorkflowVerificationAdapter;
    readonly isolation?: WorktreeIsolationAdapter;
    readonly dispatch?: WorkflowDispatchAdapter;
    readonly deploymentSemaphore?: WorkflowSemaphore;
    readonly now?: () => number;
    readonly id?: () => string;
    readonly resolveNested: (name: string) => Promise<{
        readonly module: WorkflowStartInput['module'];
        readonly source: WorkflowStartInput['source'];
    }>;
}
export declare class WorkflowControlError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export declare function resolveReadOnlyToolFilter(parent: Agent, configured?: readonly string[], denied?: readonly string[]): ToolRestriction;
export declare class WorkflowSemaphore {
    private readonly limit;
    private active;
    private readonly waiters;
    constructor(limit: number);
    acquire(signal: AbortSignal): Promise<() => void>;
    private lease;
}
/** Validate an authored child-agent request against the same contract used at dispatch. */
export declare function validateWorkflowTaskInput(value: WorkflowSpawnAgentInput): WorkflowSpawnAgentInput;
export interface WorkflowTaskAdmissionContext {
    readonly manifest: WorkflowManifest;
    readonly config: ResolvedWorkflowConfig;
    readonly totalSpawned: number;
    readonly subagents?: Pick<SubagentRuntime, 'getProvider'>;
    readonly dispatchAvailable?: boolean;
    readonly isolationAvailable?: boolean;
}
export interface WorkflowTaskAdmission {
    readonly readOnly: boolean;
    readonly route: ResolvedWorkflowConfig['modelTiers'][WorkflowModelHint];
    readonly allocation: number;
    readonly subagentProvider: string;
}
/** Validate deterministic task admission rules shared by smoke and real execution. */
export declare function validateWorkflowTaskAdmission(input: WorkflowSpawnAgentInput, context: WorkflowTaskAdmissionContext): WorkflowTaskAdmission;
export declare class DynamicWorkflowEngine {
    private readonly deps;
    private readonly runs;
    private readonly subscribers;
    private readonly now;
    private readonly id;
    constructor(deps: WorkflowEngineDependencies);
    preflight(input: WorkflowStartInput): Promise<WorkflowPreflightResult>;
    start(input: WorkflowStartInput): Promise<WorkflowRun>;
    list(): readonly WorkflowRunSnapshot[];
    get(runId: string): WorkflowRunSnapshot | undefined;
    subscribe(listener: (event: WorkflowEvent, snapshot: WorkflowRunSnapshot) => void): () => void;
    isActive(runId: string): boolean;
    disposeAll(reason?: string): Promise<void>;
    pause(runId: string): boolean;
    resume(runId: string): boolean;
    stop(runId: string, reason?: string): boolean;
    private execute;
    private finish;
    private needsApproval;
    private emit;
    private persist;
    private projectProcess;
    private projectOutcome;
    private waitAdmission;
    private createApi;
    private startTask;
    private driveTask;
    private taskPrompt;
    private expectTask;
    private taskSnapshot;
    private waitTask;
}
export declare function snapshotCapsule(module: WorkflowStartInput['module'], config: ResolvedWorkflowConfig): WorkflowCapsule | undefined;
