import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import type { ResolvedWorkflowConfig, WorkflowCapsule } from './types.js';
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
