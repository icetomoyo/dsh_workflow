import type { WorkflowModule } from './types.js';
export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
export type SpecVerdict = 'compliant' | 'issues' | 'not-verifiable';
export type QualityVerdict = 'approved' | 'needs-fixes';
export interface ReviewPacketBudget {
    readonly maxBytes: number;
    readonly maxLines: number;
    readonly maxLineChars: number;
}
export interface ReviewPacketChunk {
    readonly path: string;
    readonly contentHash: string;
}
export interface ReviewPacketMetadata {
    readonly packetPath: string;
    readonly contentHash: string;
    readonly rangeId: string;
    readonly partitionKey: string;
    readonly label: string;
    readonly scopePaths: readonly string[];
    readonly riskFlags: readonly ('routing-high')[];
    readonly budget: ReviewPacketBudget;
    readonly evidenceChunks: readonly ReviewPacketChunk[];
    readonly requirementsPresent: boolean;
    readonly testEvidencePresent: boolean;
    readonly baseRef?: string;
    readonly headRef?: string;
}
export interface ReviewPacketInput {
    readonly cwd: string;
    readonly sessionId: string;
    readonly label: string;
    /** Exact diff bytes captured by the caller. The writer never rereads Git. */
    readonly diff: string;
    readonly scope?: 'staged' | 'unstaged' | 'all' | 'compare' | 'commit';
    readonly baseRef?: string;
    readonly headRef?: string;
    readonly customPrompt?: string;
    readonly requirements?: readonly string[];
    readonly testEvidence?: readonly string[];
    /** Authoritative routing output only; the writer deliberately performs no risk inference. */
    readonly routingRisk?: 'low' | 'medium' | 'high';
    /** Override only when matching a deployment's read-tool limits. */
    readonly budget?: ReviewPacketBudget;
}
/** Writes content-addressed, immutable review packets from already-captured evidence. */
export declare function writeReviewPackets(input: ReviewPacketInput): Promise<readonly ReviewPacketMetadata[]>;
export interface ScopedReviewArgs {
    readonly packets: readonly ReviewPacketMetadata[];
    readonly lean?: boolean;
    readonly reviewFocus?: string;
}
export interface ReviewFinding {
    readonly findingId: string;
    readonly severity: ReviewSeverity;
    readonly location: string;
    readonly claim: string;
    readonly evidence: readonly string[];
    readonly suggestedFixes: readonly string[];
}
export interface VerifiedPacketReview {
    readonly specVerdict: SpecVerdict;
    readonly qualityVerdict: QualityVerdict;
    readonly unverifiedRequirements: readonly string[];
    readonly actionable: readonly (ReviewFinding & {
        readonly disposition: 'confirmed' | 'unresolved';
        readonly verificationEvidence: string;
        readonly severityReason?: string;
    })[];
    readonly audit: {
        readonly findings: readonly FindingDisposition[];
    };
    readonly unqualifiedApprovalAllowed: boolean;
}
export interface ScopedReviewResult {
    readonly summary: string;
    readonly packetResults: readonly {
        readonly contentHash: string;
        readonly result: VerifiedPacketReview;
    }[];
}
interface FindingDisposition {
    readonly findingId: string;
    readonly disposition: 'confirmed' | 'refuted' | 'unresolved';
    readonly evidence: string;
    readonly effectiveSeverity?: ReviewSeverity;
    readonly severityReason?: string;
}
export declare const scopedReviewWorkflow: WorkflowModule;
export {};
