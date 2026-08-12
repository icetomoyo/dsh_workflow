import type { WorkflowCapsule, WorkflowCatalogEntry, WorkflowExecution, WorkflowModule, WorkflowSource } from './types.js';
export interface WorkflowCatalogOptions {
    readonly project: string;
    readonly personal: string;
    readonly maxCapsuleBytes: number;
    readonly maxEntries?: number;
    readonly maxAgents: number;
    readonly maxConcurrency: number;
    readonly builtins?: readonly WorkflowModule[];
    readonly patterns?: readonly WorkflowModule[];
}
export interface WorkflowCatalog {
    readonly entries: readonly WorkflowCatalogEntry[];
    readonly truncated: boolean;
}
export interface LoadedWorkflow {
    readonly module: WorkflowModule;
    readonly source: WorkflowSource;
    readonly execution: WorkflowExecution;
    readonly path?: string;
    readonly capsule?: WorkflowCapsule;
}
export declare function discoverWorkflowCatalog(options: WorkflowCatalogOptions): Promise<WorkflowCatalog>;
export declare function loadWorkflowByName(options: WorkflowCatalogOptions, name: string, allowTrustedLocal?: boolean): Promise<LoadedWorkflow>;
export declare function saveWorkflowCapsule(directory: string, name: string, capsule: WorkflowCapsule, replace?: boolean): Promise<string>;
export declare function deleteSavedWorkflow(directory: string, name: string): Promise<void>;
export declare function renameSavedWorkflow(directory: string, from: string, to: string): Promise<string>;
