import { randomUUID } from 'node:crypto';
import { createWorkflowCapsule, validateWorkflowArgs, validateWorkflowCapsule } from './capsule.js';
import { WorkflowControlError, resolveReadOnlyToolFilter, validateWorkflowTaskAdmission } from './engine.js';
import { assertRestrictedWorkflowQuality, lintRestrictedWorkflowSource, validateRestrictedWorkflowSource } from './source-policy.js';
import { runRestrictedWorkflowScript } from './runtime.js';
import { WORKFLOW_INTERNAL } from './types.js';
const AUTHOR_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        manifest: { type: 'object', additionalProperties: true },
        source: { type: 'string' },
        intent: { type: 'object', additionalProperties: true },
        inputs: { type: 'object', additionalProperties: true },
        requires: { type: 'object', additionalProperties: true },
    },
    required: ['manifest', 'source', 'intent', 'inputs', 'requires'],
};
function text(blocks) {
    return blocks.filter((block) => block.type === 'text').map(block => block.text).join('\n');
}
async function oneShot(subagents, route, parent, prompt, signal, config, outputSchema) {
    const provider = subagents.getProvider(route.subagentProvider);
    if (provider === undefined)
        throw new Error(`workflow authoring provider "${route.subagentProvider}" is unavailable`);
    if (!provider.capabilities.toolFilter)
        throw new Error(`workflow authoring provider "${route.subagentProvider}" cannot enforce read-only scouting`);
    if (outputSchema !== undefined && !provider.capabilities.outputSchema)
        throw new Error(`workflow authoring provider "${route.subagentProvider}" cannot produce structured output`);
    const run = await subagents.start(route.subagentProvider, {
        label: outputSchema === undefined ? 'workflow-scout' : 'workflow-author',
        prompt: [{ type: 'text', text: prompt }],
        parent,
        signal,
        toolFilter: resolveReadOnlyToolFilter(parent, config.readOnlyAllowedTools, config.readOnlyToolFilter.deny),
        agentOptions: {
            ...(route.provider === undefined ? {} : { provider: route.provider }),
            ...(route.model === undefined ? {} : { model: route.model }),
            ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }),
        },
        ...(outputSchema === undefined ? {} : { outputSchema }),
    });
    try {
        const result = await run.result;
        if (result.stopReason !== 'completed')
            throw new Error(`workflow authoring child ${result.stopReason}`);
        return { text: text(result.output), ...(result.structured === undefined ? {} : { structured: result.structured }) };
    }
    finally {
        await run.dispose();
    }
}
function authorPrompt(request, scout, existing, change) {
    return `Author one reusable DSH workflow capsule payload.

The runtime contract is async function run(wf, args). Available capabilities:
- wf.phase(name, fn), wf.spawnAgent(input), wf.runAgent(input), wf.wait/snapshot/output/send/stop
- wf.parallel(thunks, {concurrency}), wf.pipeline(items, ...stages), wf.synthesize({inputs,rubric})
- one-level wf.workflow(name,args), wf.artifact(name,value), wf.log(message), wf.budget
- task input supports name, phase, prompt, scopeSummary, constraints, readOnly, subagentType/provider/model/modelHint, isolation, maxTokens, evidenceRefs, verification, outputSchema, terseResult. modelHint, when present, must be exactly fast, balanced, or deep.

The script must be deterministic capability-only JavaScript: no imports, process, filesystem, shell, network, timers, Date.now, Math.random, or direct effects. It must launch useful agents, use bounded concurrency/loops, and return JSON.

Request:
${request}

Scout evidence:
${scout}
${existing === undefined ? '' : `\nExisting capsule:\n${JSON.stringify(existing)}\nRequested change:\n${change ?? ''}`}

Return structured fields manifest/source/intent/inputs/requires. Manifest fields are name, description, phases, readOnly, optional plannedAgents, maxAgents, maxConcurrency, optional tokenBudget, optional mayUseWorktree, patterns, optional inputSchema. Allowed patterns: classify-and-act, fan-out-and-synthesize, adversarial-verification, generate-and-filter, tournament, loop-until-done.`;
}
function smokeApi(capsule, config, services) {
    let sequence = 0;
    const tasks = new Map();
    const parallelReservations = [];
    const detachedReservations = new Map();
    let artifacts = 0;
    const assertAgentName = (name) => {
        if (typeof name !== 'string' || name.trim().length === 0)
            throw new Error('workflow smoke agent name must be a non-empty string');
        return name;
    };
    const assertEvidenceRefs = (refs) => {
        for (const ref of refs ?? []) {
            const prefix = ['file:', 'diff:', 'finding:', 'task_id:'].find(candidate => ref.startsWith(candidate));
            if (prefix === undefined || ref.slice(prefix.length).trim().length === 0)
                throw new WorkflowControlError(`workflow smoke evidence reference "${ref}" must use a non-empty file:, diff:, finding:, or task_id: reference`);
            if (prefix !== 'task_id:')
                continue;
            const taskId = ref.slice(prefix.length).trim();
            if (tasks.has(taskId))
                continue;
            if ([...tasks.values()].some(task => task.name === taskId))
                throw new WorkflowControlError(`workflow smoke evidence reference "${ref}" used an agent name, but task_id: requires the taskId returned by spawnAgent/runAgent`);
            throw new WorkflowControlError(`workflow smoke evidence reference "${ref}" references an unknown workflow task id`);
        }
    };
    const begin = (input) => {
        const admission = validateWorkflowTaskAdmission(input, {
            manifest: capsule.manifest, config, totalSpawned: tasks.size,
            ...(services.subagents === undefined ? {} : { subagents: services.subagents }),
            ...(services.dispatchAvailable === undefined ? {} : { dispatchAvailable: services.dispatchAvailable }),
            ...(services.isolationAvailable === undefined ? {} : { isolationAvailable: services.isolationAvailable }),
        });
        const name = assertAgentName(input.name);
        assertEvidenceRefs(input.evidenceRefs);
        const tokenBudget = capsule.manifest.tokenBudget;
        const parallelReserved = parallelReservations.reduce((sum, scope) => sum + scope.reservations.reduce((scopeSum, value) => scopeSum + value, 0), 0);
        const activeReservation = parallelReserved + [...detachedReservations.values()].reduce((sum, value) => sum + value, 0);
        if (tokenBudget !== undefined && activeReservation + admission.allocation > tokenBudget)
            throw new WorkflowControlError('workflow token budget exceeded before agent start');
        const taskId = `smoke-task-${++sequence}-${randomUUID().slice(0, 8)}`;
        const result = { taskId, name, status: 'completed', finalText: `Smoke result for ${name}: completed, done, verified.`, structured: {}, startedAt: 1, endedAt: 2 };
        tasks.set(taskId, result);
        let reservation;
        if (tokenBudget !== undefined && parallelReservations.length > 0) {
            const scope = parallelReservations[parallelReservations.length - 1];
            const lane = scope.activeLane;
            scope.reservations[lane] = (scope.reservations[lane] ?? 0) + admission.allocation;
            reservation = { scope, lane };
        }
        return { result, allocation: admission.allocation, ...(reservation === undefined ? {} : { reservation }) };
    };
    const known = (method, taskId) => {
        const result = tasks.get(taskId);
        if (result !== undefined)
            return result;
        const named = [...tasks.values()].some(task => task.name === taskId);
        if (named) {
            throw new Error(`wf.${method}("${taskId}") used an agent name, but workflow task APIs require the taskId returned by spawnAgent/runAgent`);
        }
        throw new Error(`wf.${method}("${taskId}") references an unknown workflow task id`);
    };
    const snapshot = (method, taskId) => {
        const result = known(method, taskId);
        return { taskId: result.taskId, name: result.name, status: result.status, finalText: result.finalText, structured: result.structured, startedAt: result.startedAt, endedAt: result.endedAt };
    };
    const withConcurrentGroup = async (concurrency, operation) => {
        parallelReservations.push({ activeLane: 0, reservations: Array.from({ length: concurrency }, () => 0) });
        try {
            return await operation();
        }
        finally {
            if (parallelReservations.pop() === undefined)
                throw new WorkflowControlError('workflow smoke concurrent group is unbalanced');
        }
    };
    const withLane = async (lane, operation) => {
        const scope = parallelReservations[parallelReservations.length - 1];
        if (scope === undefined)
            throw new WorkflowControlError('workflow smoke parallel lane is outside a scope');
        scope.activeLane = lane;
        try {
            return await operation();
        }
        finally {
            scope.reservations[lane] = 0;
        }
    };
    const api = {
        [WORKFLOW_INTERNAL]: {
            parallelLimit: Math.min(capsule.manifest.maxConcurrency, config.maxConcurrency),
            beginPhase: () => 0,
            endPhase: () => { },
            beginParallel: concurrency => { parallelReservations.push({ activeLane: 0, reservations: Array.from({ length: concurrency }, () => 0) }); },
            endParallel: () => {
                if (parallelReservations.pop() === undefined)
                    throw new WorkflowControlError('workflow smoke parallel scope is unbalanced');
            },
            beginParallelLane: lane => {
                const scope = parallelReservations[parallelReservations.length - 1];
                if (scope === undefined)
                    throw new WorkflowControlError('workflow smoke parallel lane is outside a scope');
                scope.activeLane = lane;
            },
            endParallelLane: lane => {
                const scope = parallelReservations[parallelReservations.length - 1];
                if (scope === undefined)
                    throw new WorkflowControlError('workflow smoke parallel lane is outside a scope');
                scope.reservations[lane] = 0;
            },
            beginConcurrentGroup: concurrency => { parallelReservations.push({ activeLane: 0, reservations: Array.from({ length: concurrency }, () => 0) }); },
            endConcurrentGroup: () => {
                if (parallelReservations.pop() === undefined)
                    throw new WorkflowControlError('workflow smoke concurrent group is unbalanced');
            },
        },
        runId: 'author-smoke', args: {}, budget: {
            total: capsule.manifest.tokenBudget ?? null,
            spent: () => 0,
            remaining: () => capsule.manifest.tokenBudget === undefined ? Infinity : Math.max(0, capsule.manifest.tokenBudget - [...detachedReservations.values()].reduce((sum, value) => sum + value, 0) - parallelReservations.reduce((sum, scope) => sum + scope.reservations.reduce((scopeSum, value) => scopeSum + value, 0), 0)),
        },
        phase: async (_name, fn) => await fn(),
        spawnAgent: async (input) => {
            const started = begin(input);
            const { result } = started;
            if (capsule.manifest.tokenBudget !== undefined) {
                if (started.reservation !== undefined) {
                    const { scope, lane } = started.reservation;
                    scope.reservations[lane] = Math.max(0, (scope.reservations[lane] ?? 0) - started.allocation);
                }
                detachedReservations.set(result.taskId, started.allocation);
            }
            return { taskId: result.taskId, name: result.name };
        },
        runAgent: async (input) => {
            const started = begin(input);
            try {
                await Promise.resolve();
                return started.result;
            }
            finally {
                if (started.reservation !== undefined) {
                    const { scope, lane } = started.reservation;
                    scope.reservations[lane] = Math.max(0, (scope.reservations[lane] ?? 0) - started.allocation);
                }
            }
        },
        wait: async (taskId) => { const result = known('wait', taskId); detachedReservations.delete(taskId); return result; },
        snapshot: async (taskId) => snapshot('snapshot', taskId),
        output: async (taskId) => snapshot('output', taskId),
        send: async (taskId) => { known('send', taskId); },
        stop: async (taskId) => { known('stop', taskId); detachedReservations.delete(taskId); },
        // Restricted workflow source implements wf.parallel inside QuickJS. This
        // fallback is used only by trusted in-process modules and keeps the same
        // argument contract.
        parallel: async (thunks, options) => {
            const concurrency = options?.concurrency ?? thunks.length;
            if (!Number.isSafeInteger(concurrency) || concurrency <= 0)
                throw new Error('parallel concurrency must be a positive integer');
            const lanes = Math.min(concurrency, capsule.manifest.maxConcurrency, config.maxConcurrency, Math.max(1, thunks.length));
            return await withConcurrentGroup(lanes, async () => {
                const values = Array.from({ length: thunks.length }, () => null);
                let cursor = 0;
                const lane = async (laneIndex) => {
                    for (;;) {
                        const index = cursor++;
                        if (index >= thunks.length)
                            return;
                        values[index] = await withLane(laneIndex, thunks[index]);
                    }
                };
                await Promise.all(Array.from({ length: lanes }, (_, laneIndex) => lane(laneIndex)));
                return values;
            });
        },
        pipeline: async (items, ...stages) => {
            const lanes = Math.min(capsule.manifest.maxConcurrency, config.maxConcurrency, Math.max(1, items.length));
            return await withConcurrentGroup(lanes, async () => {
                const values = Array.from({ length: items.length }, () => null);
                let cursor = 0;
                const lane = async (laneIndex) => {
                    for (;;) {
                        const index = cursor++;
                        if (index >= items.length)
                            return;
                        const item = items[index];
                        let value = item;
                        for (const stage of stages)
                            value = await withLane(laneIndex, async () => await stage(value, item, index));
                        values[index] = value;
                    }
                };
                await Promise.all(Array.from({ length: lanes }, (_, laneIndex) => lane(laneIndex)));
                return values;
            });
        },
        synthesize: async (synthesis) => {
            const started = begin({ name: 'synthesis', prompt: `Synthesize the supplied evidence using this rubric:\n${synthesis.rubric}`, readOnly: true, subagentType: config.synthesisProvider, modelHint: 'deep' });
            try {
                await Promise.resolve();
                return { text: 'smoke synthesis' };
            }
            finally {
                if (started.reservation !== undefined) {
                    const { scope, lane } = started.reservation;
                    scope.reservations[lane] = Math.max(0, (scope.reservations[lane] ?? 0) - started.allocation);
                }
            }
        },
        workflow: async (name, args) => {
            if (services.resolveNested === undefined)
                return null;
            const nested = await services.resolveNested(name);
            const nestedArgs = args ?? {};
            if (nested.module.capsule !== undefined)
                validateWorkflowArgs(nested.module.capsule, nestedArgs);
            const nestedApi = Object.freeze({
                ...api,
                args: nestedArgs,
                workflow: async (nestedName) => { throw new WorkflowControlError(`nested workflows are limited to one level (attempted "${nestedName}")`); },
            });
            if (nested.module.source !== undefined) {
                return await runRestrictedWorkflowScript({
                    source: nested.module.source, wf: nestedApi, args: nestedArgs,
                    filename: `${nested.module.manifest.name}.nested-author-smoke.js`,
                    syncTimeoutMs: Math.min(config.scriptSyncTimeoutMs, 250), wallTimeoutMs: Math.min(config.scriptWallTimeoutMs, 1_000),
                });
            }
            if (nested.module.run !== undefined)
                return await nested.module.run(nestedApi, nestedArgs);
            throw new Error(`nested workflow "${name}" has neither source nor run function`);
        },
        artifact: async (name) => { artifacts += 1; return { name, path: `/smoke/${name}.json` }; }, log: () => { },
    };
    return { api, artifactCount: () => artifacts };
}
function isSmokeResultDisplayable(value, artifactCount) {
    if (artifactCount > 0)
        return true;
    if (typeof value === 'string')
        return value.trim().length > 0;
    if (value === undefined || value === null)
        return false;
    if (typeof value !== 'object')
        return true;
    if (Array.isArray(value))
        return value.length > 0;
    const record = value;
    let sawDisplayKey = false;
    const synthesis = record.synthesis;
    if (typeof synthesis === 'string') {
        sawDisplayKey = true;
        if (synthesis.trim().length > 0)
            return true;
    }
    if (synthesis !== null && typeof synthesis === 'object') {
        sawDisplayKey = true;
        const synthesisText = synthesis.text;
        if (typeof synthesisText === 'string' && synthesisText.trim().length > 0)
            return true;
    }
    for (const key of ['summary', 'report', 'text', 'result']) {
        const candidate = record[key];
        if (candidate !== undefined)
            sawDisplayKey = true;
        if (typeof candidate === 'string' && candidate.trim().length > 0)
            return true;
    }
    const displayKeys = new Set(['synthesis', 'summary', 'report', 'text', 'result']);
    if (sawDisplayKey && Object.keys(record).every(key => displayKeys.has(key)))
        return false;
    return Object.keys(record).length > 0;
}
/** Execute an authored capsule with inert agents before it can consume approval or launch real work. */
export async function smokeWorkflowCapsule(capsule, config, args, admission = {}) {
    const findings = lintRestrictedWorkflowSource(capsule.source);
    const hard = findings.filter(item => ['NO_AGENT_WORK', 'UNBOUNDED_LOOP', 'UNOBSERVED_TASK', 'UNAWAITED_AGENT'].includes(item.code));
    if (hard.length > 0)
        throw new Error(hard.map(item => `${item.code}: ${item.message}`).join('; '));
    const example = args === undefined ? capsule.inputs?.examples?.[0] ?? {} : args;
    const smoke = smokeApi(capsule, config, admission);
    const result = await runRestrictedWorkflowScript({
        source: capsule.source, wf: smoke.api, args: example,
        filename: `${capsule.manifest.name}.author-smoke.js`,
        syncTimeoutMs: Math.min(config.scriptSyncTimeoutMs, 250), wallTimeoutMs: Math.min(config.scriptWallTimeoutMs, 1_000),
    });
    if (!isSmokeResultDisplayable(result, smoke.artifactCount()))
        throw new Error('run() returned no displayable result or artifact');
}
export async function authorWorkflowCapsule(input) {
    if (input.request.trim().length === 0)
        throw new Error('workflow authoring request must be non-empty');
    const scoutRoute = input.config.modelTiers.fast;
    const authorRoute = input.config.modelTiers.deep;
    const scout = await oneShot(input.subagents, scoutRoute, input.parent, `Scout the current workspace read-only for facts needed to design this reusable multi-agent workflow. Identify scope, available tools, risks, parallel seams, and verification needs. Do not implement it.\n\n${input.request}`, input.signal, input.config);
    let priorError = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const authored = await oneShot(input.subagents, authorRoute, input.parent, `${authorPrompt(input.request, scout.text, input.existing, input.change)}${priorError.length === 0 ? '' : `\n\nRepair this validation failure from the prior attempt:\n${priorError}`}`, input.signal, input.config, AUTHOR_SCHEMA);
        try {
            if (authored.structured === undefined)
                throw new Error('workflow author returned no structured capsule payload');
            const payload = authored.structured;
            const capsule = createWorkflowCapsule({
                minDshVersion: input.config.dshVersion,
                manifest: payload.manifest,
                source: String(payload.source ?? ''),
                ...payload.intent === undefined ? {} : { intent: payload.intent },
                ...payload.inputs === undefined ? {} : { inputs: payload.inputs },
                ...payload.requires === undefined ? {} : { requires: payload.requires },
                provenance: {
                    ...(input.fromRunId === undefined ? {} : { fromRunId: input.fromRunId }),
                    ...(input.existing === undefined ? {} : { fromWorkflowName: input.existing.manifest.name, revisionOf: input.existing.manifest.name }),
                    createdAt: new Date().toISOString(),
                    dshVersion: input.config.dshVersion,
                    pluginVersion: input.config.pluginVersion,
                },
            });
            validateWorkflowCapsule(capsule, input.config);
            validateRestrictedWorkflowSource(capsule.source, `${capsule.manifest.name}.workflow.js`);
            assertRestrictedWorkflowQuality(capsule.source);
            await smokeWorkflowCapsule(capsule, input.config);
            return { capsule, warnings: lintRestrictedWorkflowSource(capsule.source).map(item => `${item.code}: ${item.message}`) };
        }
        catch (error) {
            priorError = error instanceof Error ? error.message : String(error);
            if (attempt === 3)
                throw new Error(`workflow author failed validation after ${attempt} attempts: ${priorError}`, { cause: error });
        }
    }
    throw new Error('workflow author exhausted its repair loop');
}
