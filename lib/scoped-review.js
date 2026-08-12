import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateWorkflowManifest } from './capsule.js';
const DEFAULT_PACKET_BUDGET = { maxBytes: 50 * 1024, maxLines: 2_000, maxLineChars: 2_000 };
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.go', '.rs', '.cpp', '.cc', '.cxx', '.c', '.hpp', '.h', '.cs', '.rb', '.php', '.swift', '.kt', '.kts', '.scala', '.sh']);
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.txt']);
const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', '__mocks__', 'spec', 'specs']);
const CONFIG_NAMES = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts', 'vitest.config.js', 'vite.config.ts', 'vite.config.js', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Makefile', 'Dockerfile']);
const KEY_DOC_NAMES = new Set(['README.md', 'README_CN.md', 'AGENTS.md', 'CLAUDE.md', 'docs/HLD.md', 'docs/PRD.md', 'docs/ADR.md', 'docs/DD.md', 'docs/FEATURE_LIST.md']);
function sha256(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
function normalizePacketPath(value) {
    return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}
function safeName(value) {
    const candidate = value.replace(/[^A-Za-z0-9._-]+/gu, '_').slice(0, 80).replace(/^[._-]+|[._-]+$/gu, '');
    const safe = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(candidate) ? `_${candidate}` : candidate;
    return safe || 'packet';
}
function classifyFileCategory(filePath) {
    const normalized = normalizePacketPath(filePath);
    const lower = normalized.toLowerCase();
    const extension = path.posix.extname(normalized).toLowerCase();
    const base = path.posix.basename(normalized);
    if (CONFIG_NAMES.has(base))
        return 'config';
    if (normalized.startsWith('docs/') || KEY_DOC_NAMES.has(normalized) || DOC_EXTENSIONS.has(extension))
        return 'docs';
    const segments = lower.split('/');
    if (segments.some(segment => TEST_SEGMENTS.has(segment)) || /\.(?:test|spec)\.[^.]+$/u.test(lower))
        return 'tests';
    return SOURCE_EXTENSIONS.has(extension) ? 'source' : 'other';
}
function areaIdForPath(filePath) {
    const parts = normalizePacketPath(filePath).split('/').filter(Boolean);
    if (parts.length <= 1)
        return 'cross-cutting';
    if (['packages', 'clients', 'apps', 'libs', 'services'].includes(parts[0]) && parts[1] !== undefined)
        return `${parts[0]}/${parts[1]}`;
    return parts[0] ?? 'cross-cutting';
}
function captureFileDiffs(diff) {
    const starts = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+?)\r?$/gmu)];
    if (starts.length === 0)
        return [{ path: '(cross-cutting)', partitionKey: 'cross-cutting/other', content: diff }];
    return starts.map((match, index) => {
        const start = match.index;
        const end = starts[index + 1]?.index ?? diff.length;
        const filePath = normalizePacketPath(match[2] ?? match[1] ?? '(unknown)');
        return { path: filePath, partitionKey: `${areaIdForPath(filePath)}/${classifyFileCategory(filePath)}`, content: diff.slice(start, end) };
    }).sort((left, right) => left.partitionKey.localeCompare(right.partitionKey) || left.path.localeCompare(right.path));
}
function diffStat(diff) {
    let added = 0;
    let deleted = 0;
    for (const line of diff.split(/\r?\n/u)) {
        if (line.startsWith('+') && !line.startsWith('+++'))
            added += 1;
        if (line.startsWith('-') && !line.startsWith('---'))
            deleted += 1;
    }
    return `${captureFileDiffs(diff).length} file(s), +${added}, -${deleted}`;
}
function rangeSummary(diff) {
    const firstDiff = diff.search(/^diff --git /mu);
    return firstDiff <= 0 ? [] : diff.slice(0, firstDiff).trim().split(/\r?\n/u).slice(0, 40);
}
function packetHeader(input, rangeId, partitionKey, paths) {
    const requirements = [...(input.requirements ?? []), ...(input.customPrompt?.trim() ? [input.customPrompt] : [])];
    const summary = rangeSummary(input.diff);
    return [
        '# DSH Workflow Review Packet',
        `label: ${input.label}`,
        `rangeId: ${rangeId}`,
        `partitionKey: ${partitionKey}`,
        `diffStat: ${diffStat(input.diff)}`,
        ...(input.baseRef ? [`baseRef: ${input.baseRef}`] : []),
        ...(input.headRef ? [`headRef: ${input.headRef}`] : []),
        `riskFlags: ${input.routingRisk === 'high' ? 'routing-high' : '(none)'}`,
        ...(summary.length > 0 ? ['rangeSummary:', ...summary.map(line => `  ${line}`)] : []),
        'scopePaths:',
        ...paths.map(item => `- ${item}`),
        'bindingRequirements:',
        ...(requirements.length > 0 ? requirements.map(item => `- ${item}`) : ['- (not provided)']),
        'reportedTestEvidence:',
        ...((input.testEvidence?.length ?? 0) > 0 ? input.testEvidence.map(item => `- ${item}`) : ['- (not provided)']),
    ].join('\n');
}
function fitsPacketBudget(value, budget) {
    const lines = value.split(/\r?\n/u);
    return Buffer.byteLength(value, 'utf8') <= budget.maxBytes && lines.length <= budget.maxLines && lines.every(line => line.length <= budget.maxLineChars);
}
function splitLongLine(line, maxLineChars) {
    if (line.length <= maxLineChars)
        return [line];
    const digits = String(line.length).length;
    const longestMarker = `[DSH continuation ${'9'.repeat(digits)}/${'9'.repeat(digits)}] `;
    if (longestMarker.length >= maxLineChars)
        return Array.from({ length: Math.ceil(line.length / maxLineChars) }, (_, index) => line.slice(index * maxLineChars, (index + 1) * maxLineChars));
    const payloadLimit = maxLineChars - longestMarker.length;
    const count = Math.ceil(line.length / payloadLimit);
    return Array.from({ length: count }, (_, index) => `[DSH continuation ${index + 1}/${count}] ${line.slice(index * payloadLimit, (index + 1) * payloadLimit)}`);
}
function chunkEvidence(content, budget) {
    const chunks = [];
    let current = [];
    const flush = () => {
        if (current.length > 0)
            chunks.push(current.join('\n'));
        current = [];
    };
    for (const line of content.split(/\r?\n/u).flatMap(value => splitLongLine(value, budget.maxLineChars))) {
        const prospective = [...current, line].join('\n');
        if (current.length > 0 && !fitsPacketBudget(prospective, budget))
            flush();
        current.push(line);
        if (!fitsPacketBudget(current.join('\n'), budget))
            throw new Error('review packet budget is too small for one evidence segment');
    }
    flush();
    return chunks.length > 0 ? chunks : [''];
}
function groupPackets(files, input, rangeId, budget) {
    const groups = [];
    let current = [];
    for (const file of files) {
        if (current.length > 0 && current[0].partitionKey !== file.partitionKey) {
            groups.push(current);
            current = [];
        }
        const prospective = [...current, file];
        const header = packetHeader(input, rangeId, file.partitionKey, prospective.map(item => item.path));
        const body = `${header}\n\n## Scoped diff\n\n${prospective.map(item => item.content).join('')}`;
        if (current.length > 0 && !fitsPacketBudget(body, budget)) {
            groups.push(current);
            current = [file];
        }
        else
            current = prospective;
    }
    if (current.length > 0)
        groups.push(current);
    return groups;
}
function validatePacketInput(input) {
    for (const [label, value] of [['cwd', input.cwd], ['sessionId', input.sessionId], ['label', input.label]]) {
        if (typeof value !== 'string' || value.trim().length === 0)
            throw new Error(`review packet ${label} must be a non-empty string`);
    }
    if (typeof input.diff !== 'string')
        throw new Error('review packet diff must be a string');
    for (const [label, value] of [['baseRef', input.baseRef], ['headRef', input.headRef], ['customPrompt', input.customPrompt]]) {
        if (value !== undefined && typeof value !== 'string')
            throw new Error(`review packet ${label} must be a string`);
    }
    if (input.scope !== undefined && !['staged', 'unstaged', 'all', 'compare', 'commit'].includes(input.scope))
        throw new Error('review packet scope is invalid');
    if (input.routingRisk !== undefined && !['low', 'medium', 'high'].includes(input.routingRisk))
        throw new Error('review packet routingRisk is invalid');
    for (const [label, values] of [['requirements', input.requirements], ['testEvidence', input.testEvidence]]) {
        if (values !== undefined && (!Array.isArray(values) || values.some(value => typeof value !== 'string')))
            throw new Error(`review packet ${label} must contain strings`);
    }
    const budget = input.budget ?? DEFAULT_PACKET_BUDGET;
    if (typeof budget !== 'object' || budget === null)
        throw new Error('review packet budget must be an object');
    if (![budget.maxBytes, budget.maxLines, budget.maxLineChars].every(value => Number.isSafeInteger(value) && value > 0))
        throw new Error('review packet budget must contain positive safe integers');
    return Object.freeze({ ...budget });
}
async function writeImmutableFile(filePath, content) {
    try {
        await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        const stats = await lstat(filePath);
        if (!stats.isFile() || await readFile(filePath, 'utf8') !== content)
            throw new Error(`immutable review evidence collision at ${filePath}`);
    }
}
async function ensureContainedDirectory(workspace, segments) {
    let current = workspace;
    for (const segment of segments) {
        const next = path.join(current, segment);
        try {
            await mkdir(next);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
        const stats = await lstat(next);
        if (!stats.isDirectory() || stats.isSymbolicLink())
            throw new Error(`review packet storage component is not a plain directory: ${next}`);
        current = await realpath(next);
        const relative = path.relative(workspace, current);
        if (relative.startsWith('..') || path.isAbsolute(relative))
            throw new Error('review packet directory escapes the workspace');
    }
    return current;
}
function freezePacket(value) {
    Object.freeze(value.budget);
    for (const chunk of value.evidenceChunks)
        Object.freeze(chunk);
    Object.freeze(value.evidenceChunks);
    Object.freeze(value.scopePaths);
    Object.freeze(value.riskFlags);
    return Object.freeze(value);
}
/** Writes content-addressed, immutable review packets from already-captured evidence. */
export async function writeReviewPackets(input) {
    const budget = validatePacketInput(input);
    const scope = input.scope ?? 'all';
    const rangeId = sha256(`${input.baseRef ?? ''}\0${input.headRef ?? ''}\0${scope}\0${input.diff}`);
    const workspace = await realpath(path.resolve(input.cwd));
    const resolvedPacketDir = await ensureContainedDirectory(workspace, ['.agent', 'tmp', 'sessions', safeName(input.sessionId), 'review-packets', rangeId]);
    const output = [];
    for (const [index, files] of groupPackets(captureFileDiffs(input.diff), input, rangeId, budget).entries()) {
        const partitionKey = files[0]?.partitionKey ?? 'cross-cutting/other';
        const scopePaths = files.map(file => file.path);
        const evidence = files.map(file => file.content).join('');
        const header = packetHeader(input, rangeId, partitionKey, scopePaths);
        const inlineBody = `${header}\n\n## Scoped diff\n\n${evidence}`;
        const stem = `${String(index + 1).padStart(3, '0')}-${safeName(partitionKey)}`;
        const evidenceChunks = [];
        let body = inlineBody;
        if (!fitsPacketBudget(inlineBody, budget)) {
            for (const [chunkIndex, chunk] of chunkEvidence(evidence, budget).entries()) {
                const contentHash = sha256(chunk);
                const chunkPath = path.join(resolvedPacketDir, `${stem}.chunk-${String(chunkIndex + 1).padStart(3, '0')}-${contentHash.slice(0, 12)}.diff`);
                await writeImmutableFile(chunkPath, chunk);
                evidenceChunks.push({ path: chunkPath, contentHash });
            }
            body = [header, '', '## Evidence chunks', 'Read every listed chunk in ordinal order before returning a verdict.', ...evidenceChunks.map((chunk, chunkIndex) => `${chunkIndex + 1}. ${chunk.path} sha256=${chunk.contentHash}`), '', `originalEvidenceHash: ${sha256(evidence)}`].join('\n');
        }
        const contentHash = sha256(JSON.stringify({ rangeId, label: input.label, partitionKey, scopePaths, budget, evidence, requirements: input.requirements ?? [], customPrompt: input.customPrompt ?? '', testEvidence: input.testEvidence ?? [], riskFlags: input.routingRisk === 'high' ? ['routing-high'] : [] }));
        const packetPath = path.join(resolvedPacketDir, `${stem}-${contentHash.slice(0, 12)}.md`);
        await writeImmutableFile(packetPath, body);
        output.push(freezePacket({
            packetPath, contentHash, rangeId, partitionKey, label: input.label,
            ...(input.baseRef ? { baseRef: input.baseRef } : {}), ...(input.headRef ? { headRef: input.headRef } : {}),
            scopePaths, riskFlags: input.routingRisk === 'high' ? ['routing-high'] : [], budget, evidenceChunks,
            requirementsPresent: Boolean(input.customPrompt?.trim() || input.requirements?.some(item => item.trim())),
            testEvidencePresent: Boolean(input.testEvidence?.some(item => item.trim())),
        }));
    }
    return Object.freeze(output);
}
const REVIEW_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['specVerdict', 'qualityVerdict', 'findings', 'unverifiedRequirements'],
    properties: {
        specVerdict: { type: 'string', enum: ['compliant', 'issues', 'not-verifiable'] },
        qualityVerdict: { type: 'string', enum: ['approved', 'needs-fixes'] },
        findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'location', 'claim', 'evidence'], properties: {
                    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, location: { type: 'string' }, claim: { type: 'string' }, evidence: { type: 'string' }, suggestedFix: { type: 'string' },
                } } },
        unverifiedRequirements: { type: 'array', items: { type: 'string' } },
    },
};
const VERIFY_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['findings'], properties: {
        findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['findingId', 'disposition', 'evidence'], properties: {
                    findingId: { type: 'string' }, disposition: { type: 'string', enum: ['confirmed', 'refuted', 'unresolved'] }, evidence: { type: 'string' },
                    effectiveSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, severityReason: { type: 'string' },
                } } },
    },
};
const SUMMARY_SCHEMA = { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } };
const SEVERITY = { low: 0, medium: 1, high: 2, critical: 3 };
function text(value, label) {
    if (typeof value !== 'string' || value.trim().length === 0)
        throw new Error(`${label} must be a non-empty string`);
    return value.normalize('NFC').replace(/\r\n?/gu, '\n').trim().replace(/[\t\n\f\r ]+/gu, ' ');
}
function unique(values) {
    return [...new Set(values.map(value => text(value, 'review text')))].sort();
}
function packet(value, index) {
    if (typeof value !== 'object' || value === null)
        throw new Error(`packets[${index}] must be an object`);
    for (const key of ['packetPath', 'contentHash', 'rangeId', 'partitionKey', 'label'])
        text(value[key], `packets[${index}].${key}`);
    if (!Array.isArray(value.scopePaths) || value.scopePaths.length === 0)
        throw new Error(`packets[${index}].scopePaths must be non-empty`);
    if (!Array.isArray(value.evidenceChunks))
        throw new Error(`packets[${index}].evidenceChunks must be an array`);
    if (!Array.isArray(value.riskFlags) || value.riskFlags.some(flag => flag !== 'routing-high'))
        throw new Error(`packets[${index}].riskFlags is invalid`);
    if (typeof value.requirementsPresent !== 'boolean' || typeof value.testEvidencePresent !== 'boolean')
        throw new Error(`packets[${index}] evidence flags must be booleans`);
    for (const [chunkIndex, chunk] of value.evidenceChunks.entries()) {
        text(chunk.path, `packets[${index}].evidenceChunks[${chunkIndex}].path`);
        text(chunk.contentHash, `packets[${index}].evidenceChunks[${chunkIndex}].contentHash`);
    }
    if (typeof value.budget !== 'object' || value.budget === null || ![value.budget.maxBytes, value.budget.maxLines, value.budget.maxLineChars].every(number => Number.isSafeInteger(number) && number > 0))
        throw new Error(`packets[${index}].budget is invalid`);
    return value;
}
function paths(value) {
    return [value.packetPath, ...value.evidenceChunks.map(chunk => chunk.path)];
}
function completed(result, role) {
    if (result === null || result.status !== 'completed')
        throw new Error(`${role} did not produce an accepted completed result`);
    if (result.verification !== undefined && !result.verification.ok)
        throw new Error(`${role} did not satisfy its packet-read contract`);
    if (result.structured === undefined)
        throw new Error(`${role} did not return structured output`);
    return result;
}
function rawReview(value, requirementsPresent) {
    const candidate = value;
    if (candidate === null || !['compliant', 'issues', 'not-verifiable'].includes(candidate.specVerdict ?? '') || !['approved', 'needs-fixes'].includes(candidate.qualityVerdict ?? '') || !Array.isArray(candidate.findings) || !Array.isArray(candidate.unverifiedRequirements))
        throw new Error('primary review returned invalid structured output');
    if (!requirementsPresent && candidate.specVerdict !== 'not-verifiable')
        throw new Error('a packet without requirements must use specVerdict not-verifiable');
    return candidate;
}
function findingId(contentHash, location, claim) {
    return createHash('sha256').update(`${contentHash}\0${location.replaceAll('\\', '/')}\0${claim}`).digest('hex');
}
function normalizeReview(contentHash, raw) {
    const findings = raw.findings.map(item => {
        const location = text(item.location, 'finding location').replaceAll('\\', '/');
        const claim = text(item.claim, 'finding claim');
        return { findingId: findingId(contentHash, location, claim), severity: item.severity, location, claim, evidence: [text(item.evidence, 'finding evidence')], suggestedFixes: item.suggestedFix === undefined ? [] : [text(item.suggestedFix, 'suggested fix')] };
    }).sort((left, right) => left.findingId.localeCompare(right.findingId));
    return { specVerdict: raw.specVerdict, qualityVerdict: raw.qualityVerdict, findings, unverifiedRequirements: unique(raw.unverifiedRequirements) };
}
function merge(reviews) {
    if (reviews.length === 0)
        throw new Error('at least one primary result is required');
    const variants = new Map();
    for (const review of reviews)
        for (const finding of review.findings)
            variants.set(finding.findingId, [...(variants.get(finding.findingId) ?? []), finding]);
    const findings = [...variants.entries()].map(([id, entries]) => ({
        findingId: id,
        severity: entries.map(item => item.severity).reduce((best, next) => SEVERITY[next] > SEVERITY[best] ? next : best, 'low'),
        location: entries[0].location, claim: entries[0].claim,
        evidence: unique(entries.flatMap(item => item.evidence)), suggestedFixes: unique(entries.flatMap(item => item.suggestedFixes)),
    })).sort((left, right) => left.findingId.localeCompare(right.findingId));
    return {
        specVerdict: reviews.some(review => review.specVerdict === 'issues') ? 'issues' : reviews.some(review => review.specVerdict === 'not-verifiable') ? 'not-verifiable' : 'compliant',
        qualityVerdict: reviews.some(review => review.qualityVerdict === 'needs-fixes') ? 'needs-fixes' : 'approved',
        findings, unverifiedRequirements: unique(reviews.flatMap(review => review.unverifiedRequirements)),
    };
}
async function primary(wf, value, args, second) {
    const result = completed(await wf.runAgent({
        name: `${second ? 'second-primary' : 'primary'}-${value.partitionKey}`, phase: 'primary-review', readOnly: true, modelHint: second ? 'deep' : 'balanced',
        prompt: [
            `Independently assess the immutable review packet at ${value.packetPath}.`,
            ...value.evidenceChunks.map(chunk => `Read evidence: ${chunk.path}`),
            value.requirementsPresent ? 'Judge both requirement compliance and implementation quality.' : 'No binding requirements are present; the spec verdict must be not-verifiable.',
            second ? 'This packet is high risk. Seek an independent interpretation and do not rely on another reviewer.' : '',
            args.lean ? 'Call out needless complexity unless it protects requested behavior, validation, security, accessibility, or data integrity.' : '',
            args.reviewFocus === undefined ? '' : `Additional focus: ${args.reviewFocus}`,
            'Read every listed file. Begin with only the requested structured verdict; do not add a preamble or process narration.',
            'The findings array contains only actionable defects, never approval evidence, praise, or positive observations.',
            'When the scope is compliant and approved with no actionable defect, findings must be empty.',
            'If a named requirement cannot be proven compliant or violated from surfaced evidence, use specVerdict not-verifiable, list it in unverifiedRequirements, and emit no finding for that uncertainty; absence of evidence is not proof of a defect.',
        ].filter(Boolean).join('\n'),
        scopeSummary: `${value.label}: ${value.scopePaths.join(', ')}`,
        constraints: ['read the packet and every evidence chunk', 'separate specification and quality verdicts', 'exclude praise and style preferences from findings'],
        verification: { enforcement: 'hard', requiredReadPaths: paths(value) }, outputSchema: REVIEW_SCHEMA, terseResult: true,
    }), second ? 'high-risk primary reviewer' : 'primary reviewer');
    wf.log({ message: `primary read accepted for ${value.partitionKey}`, data: { kind: 'review_packet_read', role: second ? 'high-risk-primary' : 'primary', contentHash: value.contentHash } });
    return normalizeReview(value.contentHash, rawReview(result.structured, value.requirementsPresent));
}
async function verify(wf, value, review) {
    if (review.findings.length === 0)
        return {
            ...review, actionable: [], audit: { findings: [] },
            unqualifiedApprovalAllowed: review.specVerdict === 'compliant' && review.qualityVerdict === 'approved' && review.unverifiedRequirements.length === 0,
        };
    const result = completed(await wf.runAgent({
        name: `verifier-${value.partitionKey}`, phase: 'verifier', readOnly: true, modelHint: 'deep',
        prompt: [`Attempt to disprove every candidate finding using ${value.packetPath} and its evidence.`, ...value.evidenceChunks.map(chunk => `Read evidence: ${chunk.path}`), `Candidates: ${JSON.stringify(review.findings)}`, 'Return each findingId exactly once. Explain any severity change.'].join('\n'),
        scopeSummary: `verify ${review.findings.length} candidates for ${value.label}`,
        constraints: ['fresh assessment', 'one disposition for every findingId', 'severity changes require a reason'],
        verification: { enforcement: 'hard', requiredReadPaths: paths(value) }, outputSchema: VERIFY_SCHEMA, terseResult: true,
    }), 'finding verifier');
    const dispositions = result.structured.findings;
    if (!Array.isArray(dispositions))
        throw new Error('finding verifier returned invalid structured output');
    const typed = dispositions;
    const expected = new Set(review.findings.map(finding => finding.findingId));
    if (typed.length !== expected.size || typed.some(item => !expected.delete(item.findingId)) || expected.size > 0)
        throw new Error('finding verifier must dispose every candidate exactly once');
    const byId = new Map(typed.map(item => [item.findingId, item]));
    const actionable = review.findings.flatMap(finding => {
        const disposition = byId.get(finding.findingId);
        if (disposition.disposition === 'refuted')
            return [];
        const severityReason = disposition.severityReason?.trim();
        const reasonedSeverity = disposition.effectiveSeverity !== undefined && Boolean(severityReason);
        return [{ ...finding, disposition: disposition.disposition, severity: reasonedSeverity ? disposition.effectiveSeverity : finding.severity, verificationEvidence: text(disposition.evidence, 'verification evidence'), ...(severityReason ? { severityReason: text(severityReason, 'severity reason') } : {}) }];
    });
    wf.log({ message: `verification read accepted for ${value.partitionKey}`, data: { kind: 'review_packet_read', role: 'verification', contentHash: value.contentHash, reason: 'candidate findings' } });
    return {
        specVerdict: review.specVerdict, qualityVerdict: review.qualityVerdict, unverifiedRequirements: review.unverifiedRequirements,
        actionable, audit: { findings: typed },
        unqualifiedApprovalAllowed: actionable.length === 0 && review.unverifiedRequirements.length === 0 && review.specVerdict === 'compliant' && review.qualityVerdict === 'approved',
    };
}
async function reviewPacket(wf, value, args) {
    const reviews = [await primary(wf, value, args, false)];
    if (value.riskFlags.includes('routing-high'))
        reviews.push(await primary(wf, value, args, true));
    const result = await verify(wf, value, merge(reviews));
    wf.log({ message: `quality gate completed for ${value.partitionKey}`, data: { kind: 'review_quality_gate', contentHash: value.contentHash, actionableFindings: result.actionable.length, unresolvedFindings: result.actionable.filter(item => item.disposition === 'unresolved').length, unqualifiedApprovalAllowed: result.unqualifiedApprovalAllowed } });
    return { contentHash: value.contentHash, result };
}
async function run(wf, unknownArgs) {
    const args = unknownArgs;
    if (args === null || !Array.isArray(args.packets) || args.packets.length === 0)
        throw new Error('scoped-review requires a non-empty packets array');
    const packets = args.packets.map(packet);
    const packetResults = await wf.parallel(packets.map(value => async () => await reviewPacket(wf, value, args)), { concurrency: 4 });
    if (packetResults.some(result => result === null))
        throw new Error('at least one review packet failed; no aggregate verdict was accepted');
    const completedResults = packetResults;
    await wf.artifact('scoped-review-audit', completedResults);
    const final = completed(await wf.runAgent({
        name: 'final-review-synthesis', phase: 'final-synthesis', readOnly: true, modelHint: 'deep',
        prompt: `Synthesize these verified packet results. Preserve severity and uncertainty, omit refuted candidates, cite locations, and explicitly state when nothing actionable remains.\n${JSON.stringify(completedResults)}`,
        constraints: ['do not invent evidence', 'retain unresolved status', 'do not silently downgrade severity'], outputSchema: SUMMARY_SCHEMA, terseResult: true,
    }), 'final review synthesis');
    const summary = final.structured.summary;
    if (typeof summary !== 'string')
        throw new Error('final review synthesis omitted summary');
    return { summary, packetResults: completedResults };
}
export const scopedReviewWorkflow = {
    manifest: validateWorkflowManifest({
        name: 'scoped-review', description: 'Review immutable packets with independent primaries, adversarial verification, and an audit artifact.',
        phases: ['primary-review', 'verifier', 'final-synthesis'], readOnly: true, maxAgents: 64, maxConcurrency: 4,
        patterns: ['fan-out-and-synthesize', 'adversarial-verification'],
        inputSchema: { type: 'object', properties: { packets: { type: 'array', items: { type: 'json' } }, lean: { type: 'boolean' }, reviewFocus: { type: 'string' } }, required: ['packets'], additionalProperties: false },
    }),
    execution: 'trusted-package', run,
};
