import type { WorkflowCapsule, WorkflowManifest } from './types.js';
export declare const DSH_WORKFLOW_FORMAT: "dsh.workflow";
export declare const DSH_WORKFLOW_VERSION: 1;
export declare const DSH_WORKFLOW_API_VERSION: 1;
export declare function validateWorkflowManifest(value: unknown, limits?: {
    readonly maxAgents?: number;
    readonly maxConcurrency?: number;
}): WorkflowManifest;
export declare function validateWorkflowCapsule(value: unknown, limits?: {
    readonly maxAgents?: number;
    readonly maxConcurrency?: number;
}): WorkflowCapsule;
export declare function validateWorkflowArgs(capsule: WorkflowCapsule, args: unknown): void;
export declare function createWorkflowCapsule(input: Omit<WorkflowCapsule, 'format' | 'version' | 'workflowApiVersion'>): WorkflowCapsule;
