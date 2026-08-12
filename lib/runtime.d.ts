import { type WorkflowApi } from './types.js';
export interface RestrictedWorkflowRunOptions {
    readonly source: string;
    readonly wf: WorkflowApi;
    readonly args?: unknown;
    readonly filename?: string;
    readonly syncTimeoutMs: number;
    readonly wallTimeoutMs: number;
    /** Called synchronously when the wall clock expires so the owner can abort child work. */
    readonly onTimeout?: () => void;
}
export declare function snapshotWorkflowJson<T>(value: T, label: string, allowUndefined?: boolean): T;
export declare function runRestrictedWorkflowScript(options: RestrictedWorkflowRunOptions): Promise<unknown>;
