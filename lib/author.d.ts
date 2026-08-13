import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import { type ResolvedWorkflowConfig, type WorkflowCapsule, type WorkflowModule } from './types.js';
export interface WorkflowSmokeAdmissionOptions {
    readonly subagents?: Pick<SubagentRuntime, 'getProvider'>;
    readonly dispatchAvailable?: boolean;
    readonly isolationAvailable?: boolean;
    readonly resolveNested?: (name: string) => Promise<{
        readonly module: WorkflowModule;
    }>;
}
/** Execute an authored capsule with inert agents before it can consume approval or launch real work. */
export declare function smokeWorkflowCapsule(capsule: WorkflowCapsule, config: ResolvedWorkflowConfig, args?: unknown, admission?: WorkflowSmokeAdmissionOptions): Promise<void>;
export declare function authorWorkflowCapsule(input: {
    readonly request: string;
    readonly parent: Agent;
    readonly subagents: SubagentRuntime;
    readonly config: ResolvedWorkflowConfig;
    readonly signal: AbortSignal;
    readonly existing?: WorkflowCapsule;
    readonly change?: string;
    readonly fromRunId?: string;
}): Promise<{
    readonly capsule: WorkflowCapsule;
    readonly warnings: readonly string[];
}>;
