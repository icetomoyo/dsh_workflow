import type { WorkflowArtifactRef, WorkflowCapsule, WorkflowEvent, WorkflowRunSnapshot, WorkflowTaskResult } from './types.js';
export interface WorkflowRunWriter {
    readonly runId: string;
    readonly runDir: string;
    append(type: WorkflowEvent['type'], data: WorkflowEvent['data']): WorkflowEvent;
    artifact(name: string, value: unknown): WorkflowArtifactRef;
    snapshotScript(capsule: WorkflowCapsule): void;
    writeSnapshot(snapshot: WorkflowRunSnapshot): void;
    cacheKey(input: unknown, occurrence: number): string;
    getCached(key: string, priorRunId?: string): WorkflowTaskResult | undefined;
    setCached(key: string, result: WorkflowTaskResult): void;
}
export interface WorkflowPruneOptions {
    readonly keep?: number;
    readonly olderThanMs?: number;
    readonly dryRun?: boolean;
}
export interface WorkflowPruneResult {
    readonly candidates: readonly string[];
    readonly deleted: readonly string[];
}
export type WorkflowIdentityResolution = {
    readonly kind: 'run';
    readonly runId: string;
    readonly snapshot: WorkflowRunSnapshot;
} | {
    readonly kind: 'ambiguous';
    readonly target: string;
    readonly runIds: readonly string[];
} | {
    readonly kind: 'missing';
    readonly target: string;
};
export declare class WorkflowRunStore {
    readonly root: string;
    private readonly now;
    constructor(root: string, now?: () => number, owner?: string);
    runDir(runId: string): string;
    create(runId: string): WorkflowRunWriter;
    get(runId: string): WorkflowRunSnapshot | undefined;
    getCapsule(runId: string): WorkflowCapsule | undefined;
    getEvents(runId: string): readonly WorkflowEvent[];
    list(): readonly WorkflowRunSnapshot[];
    resolveIdentity(target: string): WorkflowIdentityResolution;
    rename(runId: string, displayName: string): WorkflowRunSnapshot;
    delete(runId: string, force?: boolean): void;
    prune(options: WorkflowPruneOptions): WorkflowPruneResult;
    archiveRun(runId: string, archiveRoot: string): string;
}
