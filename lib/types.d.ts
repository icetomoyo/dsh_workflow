import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentRun, SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent';
import type { ObjectJsonSchema, ToolRestriction } from '@deepseek-ai/dsh-tools';
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
    [key: string]: JsonValue;
};
export declare const WORKFLOW_PATTERN_IDS: readonly ["classify-and-act", "fan-out-and-synthesize", "adversarial-verification", "generate-and-filter", "tournament", "loop-until-done"];
export type WorkflowPatternId = typeof WORKFLOW_PATTERN_IDS[number];
export type WorkflowModelHint = 'fast' | 'balanced' | 'deep';
export type WorkflowIsolation = 'shared-cwd' | 'worktree';
export type WorkflowSource = 'built-in' | 'pattern' | 'project' | 'personal' | 'inline' | 'run-snapshot';
export type WorkflowExecution = 'trusted-package' | 'trusted-local' | 'capability-generated';
export type WorkflowRunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'denied' | 'stopped';
export type WorkflowTaskStatus = 'running' | 'completed' | 'completed_unverified' | 'failed' | 'stopped';
export interface WorkflowInputSchema {
    readonly type: 'object';
    readonly properties?: Readonly<Record<string, WorkflowJsonSchema>>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean;
}
export type WorkflowJsonSchema = WorkflowInputSchema | {
    readonly type: 'array';
    readonly items: WorkflowJsonSchema;
} | {
    readonly type: 'string';
    readonly enum?: readonly string[];
    readonly const?: string;
} | {
    readonly type: 'number' | 'integer' | 'boolean' | 'json';
    readonly const?: JsonPrimitive;
};
export interface WorkflowManifest {
    readonly name: string;
    readonly description: string;
    readonly phases: readonly string[];
    readonly readOnly: boolean;
    readonly plannedAgents?: number;
    readonly maxAgents: number;
    readonly maxConcurrency: number;
    readonly tokenBudget?: number;
    readonly mayUseWorktree?: boolean;
    readonly patterns: readonly WorkflowPatternId[];
    readonly inputSchema?: WorkflowInputSchema;
}
export interface WorkflowCapsuleIntent {
    readonly taskClass: string;
    readonly patterns?: readonly string[];
    readonly originalRequest?: string;
    readonly reusableFor?: readonly string[];
    readonly notFor?: readonly string[];
}
export interface WorkflowCapsuleInputs {
    readonly description: string;
    readonly examples?: readonly JsonValue[];
}
export interface WorkflowCapsuleRequirements {
    readonly environment?: readonly ('git-repo' | 'worktree-capable')[];
    readonly tools?: readonly string[];
    readonly mcp?: readonly string[];
    readonly skills?: readonly string[];
    readonly modelTiers?: readonly WorkflowModelHint[];
    readonly userInteraction?: boolean;
}
export interface WorkflowCapsuleProvenance {
    readonly fromRunId?: string;
    readonly fromWorkflowName?: string;
    readonly revisionOf?: string;
    readonly replacesWorkflowName?: string;
    readonly createdAt: string;
    readonly dshVersion: string;
    readonly pluginVersion: string;
}
export interface WorkflowCapsule {
    readonly format: 'dsh.workflow';
    readonly version: 1;
    readonly workflowApiVersion: 1;
    readonly minDshVersion: string;
    readonly manifest: WorkflowManifest;
    readonly source: string;
    readonly intent?: WorkflowCapsuleIntent;
    readonly inputs?: WorkflowCapsuleInputs;
    readonly requires?: WorkflowCapsuleRequirements;
    readonly provenance?: WorkflowCapsuleProvenance;
}
export interface WorkflowModule {
    readonly manifest: WorkflowManifest;
    readonly execution: WorkflowExecution;
    readonly source?: string;
    readonly capsule?: WorkflowCapsule;
    readonly run?: (wf: WorkflowApi, args: unknown) => Promise<unknown>;
}
export interface WorkflowCatalogEntry {
    readonly name: string;
    readonly source: WorkflowSource;
    readonly execution: WorkflowExecution;
    readonly path?: string;
    readonly description?: string;
    readonly manifest?: WorkflowManifest;
    readonly valid: boolean;
    readonly error?: string;
}
export interface WorkflowVerification {
    readonly enforcement?: 'hard' | 'warn';
    readonly requiresMutation?: boolean;
    readonly requiredChangedPaths?: readonly string[];
    readonly requiredReadPaths?: readonly string[];
    readonly minFinalTextChars?: number;
    readonly rejectPreparatoryFinalText?: boolean;
}
export interface WorkflowSpawnAgentInput {
    readonly name: string;
    readonly phase?: string;
    readonly prompt: string;
    readonly scopeSummary?: string;
    readonly constraints?: readonly string[];
    readonly readOnly?: boolean;
    readonly subagentType?: string;
    readonly target?: {
        readonly agentId: string;
        readonly expectedConfigurationRevision?: string;
    };
    readonly modelHint?: WorkflowModelHint;
    readonly provider?: string;
    readonly model?: string;
    readonly isolation?: WorkflowIsolation;
    readonly effort?: string;
    readonly maxTokens?: number;
    readonly evidenceRefs?: readonly string[];
    readonly verification?: WorkflowVerification;
    readonly outputSchema?: ObjectJsonSchema;
    readonly terseResult?: boolean;
}
export interface WorkflowTaskHandle {
    readonly taskId: string;
    readonly name: string;
}
export interface WorkflowTaskResult {
    readonly taskId: string;
    readonly name: string;
    readonly status: Exclude<WorkflowTaskStatus, 'running'>;
    readonly finalText: string;
    readonly structured?: unknown;
    readonly childId?: string;
    readonly stopReason?: string;
    readonly startedAt: number;
    readonly endedAt: number;
    readonly provider?: string;
    readonly subagentProvider?: string;
    readonly model?: string;
    readonly requestedTier?: WorkflowModelHint | 'inherited';
    readonly tierOutcome?: 'applied' | 'balanced-parent' | 'fast-write-ineligible' | 'unconfigured' | 'shadowed-by-selector' | 'inherited';
    readonly providerSource?: 'explicit' | 'specialist' | 'tier' | 'parent' | 'default';
    readonly modelSource?: 'explicit' | 'specialist' | 'tier' | 'parent';
    readonly initialProvider?: string;
    readonly initialModel?: string;
    readonly finalProvider?: string;
    readonly finalModel?: string;
    readonly fallbackReason?: string;
    readonly resolvedEffort?: string;
    readonly iterations?: number;
    readonly durationMs?: number;
    readonly artifacts?: readonly string[];
    readonly tokenUsage?: number;
    readonly usage?: WorkflowTaskUsage;
    readonly verification?: WorkflowTaskVerificationResult;
    readonly verificationWarnings?: readonly string[];
    readonly origin?: 'executed' | 'replayed-from-cache';
    readonly limitReached?: boolean;
}
export interface WorkflowTaskUsage {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly totalTokens: number;
}
export interface WorkflowTaskVerificationResult {
    readonly ok: boolean;
    readonly reasons: readonly string[];
    readonly enforcement?: 'hard' | 'warn';
    readonly changedPaths?: readonly string[];
    readonly mutationToolCalls?: readonly string[];
    readonly mutationEvidence?: boolean;
    readonly readPaths?: readonly string[];
}
export interface WorkflowTaskSnapshot {
    readonly taskId: string;
    readonly name: string;
    readonly status: WorkflowTaskStatus;
    readonly phase?: string;
    readonly childId?: string;
    readonly phaseId?: string;
    readonly childAgentId?: string;
    readonly lastText?: string;
    readonly finalText?: string;
    readonly structured?: unknown;
    readonly startedAt: number;
    readonly endedAt?: number;
}
export interface WorkflowBudget {
    readonly total: number | null;
    spent(): number;
    remaining(): number;
}
export interface WorkflowSynthesis {
    readonly text: string;
}
export declare const WORKFLOW_INTERNAL: unique symbol;
export interface WorkflowInternalApi {
    readonly parallelLimit?: number;
    beginPhase(name: string): number;
    endPhase(token: number): void;
    beginParallel?(concurrency: number): void;
    endParallel?(): void;
    beginParallelLane?(lane: number): void;
    endParallelLane?(lane: number): void;
    beginConcurrentGroup?(concurrency: number): void;
    endConcurrentGroup?(): void;
}
export interface WorkflowApi {
    readonly [WORKFLOW_INTERNAL]?: WorkflowInternalApi;
    readonly runId: string;
    readonly args: unknown;
    readonly budget: WorkflowBudget;
    phase<T>(name: string, fn: () => Promise<T>): Promise<T>;
    spawnAgent(input: WorkflowSpawnAgentInput): Promise<WorkflowTaskHandle>;
    runAgent(input: WorkflowSpawnAgentInput): Promise<WorkflowTaskResult | null>;
    wait(taskId: string, options?: {
        readonly timeoutMs?: number;
    }): Promise<WorkflowTaskResult>;
    snapshot(taskId: string): Promise<WorkflowTaskSnapshot>;
    output(taskId: string): Promise<WorkflowTaskSnapshot>;
    send(taskId: string, content: string): Promise<void>;
    stop(taskId: string, reason: string): Promise<void>;
    parallel<T>(thunks: readonly (() => Promise<T>)[], options?: {
        readonly concurrency?: number;
    }): Promise<(T | null)[]>;
    pipeline<T>(items: readonly T[], ...stages: readonly ((value: unknown, item: T, index: number) => Promise<unknown>)[]): Promise<(unknown | null)[]>;
    synthesize(input: {
        readonly inputs: unknown;
        readonly rubric: string;
    }): Promise<WorkflowSynthesis>;
    workflow(name: string, args?: unknown): Promise<unknown>;
    artifact(name: string, value: unknown): Promise<WorkflowArtifactRef>;
    log(event: string | {
        readonly message: string;
        readonly data?: unknown;
    }): void;
}
export interface WorkflowArtifactRef {
    readonly name: string;
    readonly path: string;
}
export type WorkflowEventType = 'workflow-started' | 'workflow-log' | 'workflow-completed' | 'workflow-failed' | 'workflow-stopped' | 'phase-started' | 'phase-completed' | 'agent-started' | 'agent-completed' | 'agent-message' | 'synthesis-started' | 'synthesis-completed' | 'nested-started' | 'nested-completed' | 'artifact-written' | 'workflow-paused' | 'workflow-resumed' | 'cache-hit';
export interface WorkflowEvent {
    readonly seq: number;
    readonly time: number;
    readonly type: WorkflowEventType;
    readonly data: Readonly<Record<string, JsonValue>>;
}
export interface WorkflowCostReport {
    readonly wallClockDurationMs: number;
    readonly agentsStarted: number;
    readonly agentsCompleted: number;
    readonly cacheHits: number;
    readonly tokenUsage: number;
    readonly peakConcurrency: number;
}
export type WorkflowProcessItemStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
export interface WorkflowProcessItem {
    readonly id: string;
    readonly title: string;
    readonly kind: 'phase' | 'agent' | 'step' | 'artifact';
    readonly status: WorkflowProcessItemStatus;
    readonly phaseId?: string;
    readonly parentId?: string;
    readonly agentId?: string;
    readonly childAgentId?: string;
    readonly summary?: string;
    readonly origin?: 'executed' | 'replayed-from-cache';
    readonly startedAt?: string;
    readonly endedAt?: string;
}
export interface WorkflowProcessSnapshot {
    readonly runId: string;
    readonly workflowName: string;
    readonly status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
    readonly startedAt: string;
    readonly updatedAt: string;
    readonly items: readonly WorkflowProcessItem[];
    readonly counts: Readonly<Record<WorkflowProcessItemStatus, number>>;
    readonly progress: {
        readonly spawnedAgents: number;
        readonly finishedAgents: number;
        readonly activeAgents: number;
        readonly failedAgents: number;
        readonly stoppedAgents: number;
        readonly replayedAgents: number;
    };
}
export interface WorkflowOutcomeResult {
    readonly taskId: string;
    readonly name: string;
    readonly status: Exclude<WorkflowTaskStatus, 'running'>;
    readonly summary: string;
    readonly structured?: unknown;
    readonly artifacts: readonly string[];
    readonly usage?: WorkflowTaskUsage;
}
export interface WorkflowOutcome {
    readonly runId: string;
    readonly status: 'completed' | 'partial' | 'failed' | 'interrupted';
    readonly summary: string;
    readonly results: readonly WorkflowOutcomeResult[];
    readonly artifacts: readonly WorkflowArtifactRef[];
    readonly coverage: readonly string[];
    readonly unresolved: readonly string[];
    readonly errors: readonly {
        readonly taskId?: string;
        readonly name?: string;
        readonly message: string;
    }[];
    readonly usage: WorkflowTaskUsage & {
        readonly totalSpawned: number;
    };
}
export interface WorkflowRunSnapshot {
    readonly runId: string;
    readonly workflow: string;
    readonly displayName: string;
    readonly status: WorkflowRunStatus;
    readonly source: WorkflowSource;
    readonly execution: WorkflowExecution;
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly totalSpawned: number;
    readonly activeAgents: number;
    readonly eventCount: number;
    readonly phase?: string;
    readonly resultSummary?: string;
    readonly result?: unknown;
    readonly error?: string;
    readonly artifacts: readonly WorkflowArtifactRef[];
    readonly cost?: WorkflowCostReport;
    readonly sourceRunId?: string;
    readonly savedWorkflowName?: string;
    readonly revisionOf?: string;
    readonly resumedFromRunId?: string;
    readonly process?: WorkflowProcessSnapshot;
    readonly outcome?: WorkflowOutcome;
}
export interface WorkflowPreflightResult {
    readonly ok: boolean;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
    readonly approvalSummary: string;
}
export interface WorkflowStartInput {
    readonly module: WorkflowModule;
    readonly source: WorkflowSource;
    readonly parent: Agent;
    readonly args?: unknown;
    readonly displayName?: string;
    readonly signal?: AbortSignal;
    readonly savedWorkflowName?: string;
    readonly sourceRunId?: string;
    readonly revisionOf?: string;
    readonly resumeFromRunId?: string;
    readonly requireApproval?: boolean;
    /** Internal chain depth used to enforce the one-level nested-workflow contract. */
    readonly nestingDepth?: number;
}
export interface WorkflowRun {
    readonly runId: string;
    readonly done: Promise<WorkflowRunSnapshot>;
    getSnapshot(): WorkflowRunSnapshot;
}
export interface ModelTierRoute {
    /** DSH subagent transport/provider name passed to ctx.subagents.start(). */
    readonly subagentProvider: string;
    /** Optional DSH LLM provider route passed through AgentOptions. */
    readonly provider?: string;
    readonly model?: string;
    readonly maxTokens?: number;
}
export interface WorkflowVerificationAdapter {
    /** Stable deployment-controlled version included in resume-cache identity. */
    readonly cacheIdentity?: string;
    preflight(cwd: string, verification: WorkflowVerification): Promise<readonly string[] | WorkflowTaskVerificationResult>;
    verify(cwd: string, input: WorkflowSpawnAgentInput, result: WorkflowTaskResult): Promise<readonly string[] | WorkflowTaskVerificationResult>;
}
export interface WorktreeIsolationAdapter {
    readonly name: string;
    prepare(input: {
        readonly runId: string;
        readonly taskId: string;
        readonly cwd: string;
        readonly parent: Agent;
    }): Promise<{
        readonly cwd: string;
        readonly parent: Agent;
        dispose(): Promise<void>;
    }>;
}
/** Deployment seam for KodaX target-agent dispatch and provider-specific effort controls. */
export interface WorkflowDispatchAdapter {
    start(input: {
        readonly target?: WorkflowSpawnAgentInput['target'];
        readonly effort?: string;
        readonly provider: string;
        readonly request: SubagentStartRequest;
        readonly subagents: SubagentRuntime;
    }): Promise<SubagentRun | WorkflowDispatchResult>;
}
/** Optional deployment telemetry for target/effort transports that DSH cannot infer locally. */
export interface WorkflowDispatchTelemetry {
    readonly usage?: WorkflowTaskUsage;
    readonly provider?: string;
    readonly model?: string;
    readonly initialProvider?: string;
    readonly initialModel?: string;
    readonly finalProvider?: string;
    readonly finalModel?: string;
    readonly fallbackReason?: string;
    readonly resolvedEffort?: string;
    readonly iterations?: number;
    readonly durationMs?: number;
}
export interface WorkflowDispatchResult {
    readonly run: SubagentRun;
    readonly telemetry?: WorkflowDispatchTelemetry | Promise<WorkflowDispatchTelemetry>;
}
export interface ResolvedWorkflowConfig {
    readonly projectDirectory: string;
    readonly personalDirectory: string;
    readonly runDirectory: string;
    readonly maxCapsuleBytes: number;
    readonly maxCatalogEntries: number;
    readonly maxAgents: number;
    readonly maxConcurrency: number;
    readonly maxResultChars: number;
    readonly scriptSyncTimeoutMs: number;
    readonly scriptWallTimeoutMs: number;
    readonly defaultProvider: string;
    readonly synthesisProvider: string;
    readonly modelTiers: Readonly<Record<WorkflowModelHint, ModelTierRoute>>;
    readonly readOnlyAllowedTools?: readonly string[];
    /** @deprecated Extra names removed from readOnlyAllowedTools after discovery. */
    readonly readOnlyToolFilter: ToolRestriction;
    readonly approvalMode: 'never' | 'generated-and-local' | 'always';
    readonly availableTools: readonly string[];
    readonly availableMcp: readonly string[];
    readonly availableSkills: readonly string[];
    readonly maxRetainedRuns: number;
    readonly pluginVersion: string;
    readonly dshVersion: string;
}
