export declare class WorkflowScriptError extends Error {
    readonly fatal: boolean;
    constructor(message: string, options?: ErrorOptions & {
        readonly fatal?: boolean;
    });
}
export declare function validateRestrictedWorkflowSource(source: string, filename?: string): void;
export interface WorkflowQualityFinding {
    readonly code: string;
    readonly message: string;
}
export declare function lintRestrictedWorkflowSource(source: string): readonly WorkflowQualityFinding[];
export declare function assertRestrictedWorkflowQuality(source: string): void;
