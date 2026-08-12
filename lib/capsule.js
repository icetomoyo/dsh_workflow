import { WORKFLOW_PATTERN_IDS } from './types.js';
export const DSH_WORKFLOW_FORMAT = 'dsh.workflow';
export const DSH_WORKFLOW_VERSION = 1;
export const DSH_WORKFLOW_API_VERSION = 1;
const SAFE_NAME = /^[a-z][a-z0-9-]{0,63}$/u;
const MODEL_HINTS = new Set(['fast', 'balanced', 'deep']);
const ENV_REQUIREMENTS = new Set(['git-repo', 'worktree-capable']);
function record(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new TypeError(`${label} must be an object`);
    return value;
}
function exact(value, allowed, label) {
    const set = new Set(allowed);
    const unknown = Object.keys(value).find(key => !set.has(key));
    if (unknown !== undefined)
        throw new TypeError(`${label} has unsupported field "${unknown}"`);
}
function string(value, key, label) {
    const item = value[key];
    if (typeof item !== 'string' || item.trim().length === 0)
        throw new TypeError(`${label}.${key} must be a non-empty string`);
    return item;
}
function optionalString(value, key, label) {
    if (value[key] === undefined)
        return undefined;
    return string(value, key, label);
}
function positiveInteger(value, key, label, optional = false) {
    const item = value[key];
    if (item === undefined && optional)
        return undefined;
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item <= 0) {
        throw new TypeError(`${label}.${key} must be a positive safe integer${optional ? ' when provided' : ''}`);
    }
    return item;
}
function boolean(value, key, label, optional = false) {
    const item = value[key];
    if (item === undefined && optional)
        return undefined;
    if (typeof item !== 'boolean')
        throw new TypeError(`${label}.${key} must be a boolean${optional ? ' when provided' : ''}`);
    return item;
}
function stringArray(value, label, allowEmpty = true) {
    if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
        || value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
        throw new TypeError(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string array`);
    }
    return Object.freeze([...value]);
}
function validateJson(value, label) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0))
        return value;
    if (Array.isArray(value))
        return value.map((item, index) => validateJson(item, `${label}.${index}`));
    const input = record(value, label);
    const output = {};
    for (const [key, item] of Object.entries(input)) {
        if (item === undefined)
            throw new TypeError(`${label}.${key} must not be undefined`);
        output[key] = validateJson(item, `${label}.${key}`);
    }
    return output;
}
function validateSchema(value, label) {
    const input = record(value, label);
    const type = input.type;
    if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'json'].includes(String(type))) {
        throw new TypeError(`${label}.type is unsupported`);
    }
    if (type === 'object') {
        exact(input, ['type', 'properties', 'required', 'additionalProperties'], label);
        const propertiesInput = input.properties === undefined ? {} : record(input.properties, `${label}.properties`);
        const properties = {};
        for (const [key, schema] of Object.entries(propertiesInput))
            properties[key] = validateSchema(schema, `${label}.properties.${key}`);
        const required = input.required === undefined ? undefined : stringArray(input.required, `${label}.required`);
        if (required?.some(key => !(key in properties)))
            throw new TypeError(`${label}.required names an unknown property`);
        if (input.additionalProperties !== undefined && typeof input.additionalProperties !== 'boolean') {
            throw new TypeError(`${label}.additionalProperties must be a boolean`);
        }
        return {
            type: 'object',
            ...(Object.keys(properties).length === 0 ? {} : { properties }),
            ...(required === undefined ? {} : { required }),
            ...(input.additionalProperties === undefined ? {} : { additionalProperties: input.additionalProperties }),
        };
    }
    if (type === 'array') {
        exact(input, ['type', 'items'], label);
        if (input.items === undefined)
            throw new TypeError(`${label}.items is required`);
        return { type: 'array', items: validateSchema(input.items, `${label}.items`) };
    }
    exact(input, ['type', 'enum', 'const'], label);
    if (input.enum !== undefined) {
        if (type !== 'string')
            throw new TypeError(`${label}.enum is supported only for strings`);
        const values = stringArray(input.enum, `${label}.enum`, false);
        return { type: 'string', enum: values };
    }
    if (input.const !== undefined) {
        const constant = validateJson(input.const, `${label}.const`);
        if (typeof constant === 'object')
            throw new TypeError(`${label}.const must be a primitive`);
        if (type === 'string')
            return { type: 'string', const: constant };
        return { type: type, const: constant };
    }
    return { type: type };
}
export function validateWorkflowManifest(value, limits) {
    const input = record(value, 'manifest');
    exact(input, [
        'name', 'description', 'phases', 'readOnly', 'plannedAgents', 'maxAgents', 'maxConcurrency',
        'tokenBudget', 'mayUseWorktree', 'patterns', 'inputSchema',
    ], 'manifest');
    const name = string(input, 'name', 'manifest');
    if (!SAFE_NAME.test(name))
        throw new TypeError('manifest.name must be kebab-case (1-64 characters)');
    const phases = stringArray(input.phases, 'manifest.phases', false);
    const patternsRaw = stringArray(input.patterns, 'manifest.patterns', false);
    const patterns = [];
    for (const pattern of patternsRaw) {
        if (!WORKFLOW_PATTERN_IDS.includes(pattern))
            throw new TypeError(`manifest.patterns contains unsupported id "${pattern}"`);
        patterns.push(pattern);
    }
    const plannedAgents = positiveInteger(input, 'plannedAgents', 'manifest', true);
    const maxAgents = positiveInteger(input, 'maxAgents', 'manifest');
    const maxConcurrency = positiveInteger(input, 'maxConcurrency', 'manifest');
    if (plannedAgents !== undefined && plannedAgents > maxAgents)
        throw new TypeError('manifest.plannedAgents must not exceed manifest.maxAgents');
    if (maxConcurrency > maxAgents)
        throw new TypeError('manifest.maxConcurrency must not exceed manifest.maxAgents');
    if (limits?.maxAgents !== undefined && maxAgents > limits.maxAgents)
        throw new TypeError(`manifest.maxAgents ${maxAgents} exceeds the deployment ceiling ${limits.maxAgents}`);
    if (limits?.maxConcurrency !== undefined && maxConcurrency > limits.maxConcurrency)
        throw new TypeError(`manifest.maxConcurrency ${maxConcurrency} exceeds the deployment ceiling ${limits.maxConcurrency}`);
    const tokenBudget = positiveInteger(input, 'tokenBudget', 'manifest', true);
    const mayUseWorktree = boolean(input, 'mayUseWorktree', 'manifest', true);
    const inputSchema = input.inputSchema === undefined ? undefined : validateSchema(input.inputSchema, 'manifest.inputSchema');
    return Object.freeze({
        name,
        description: string(input, 'description', 'manifest'),
        phases,
        readOnly: boolean(input, 'readOnly', 'manifest'),
        ...(plannedAgents === undefined ? {} : { plannedAgents }),
        maxAgents,
        maxConcurrency,
        ...(tokenBudget === undefined ? {} : { tokenBudget }),
        ...(mayUseWorktree === undefined ? {} : { mayUseWorktree }),
        patterns: Object.freeze(patterns),
        ...(inputSchema === undefined ? {} : { inputSchema }),
    });
}
function intent(value) {
    if (value === undefined)
        return undefined;
    const input = record(value, 'intent');
    exact(input, ['taskClass', 'patterns', 'originalRequest', 'reusableFor', 'notFor'], 'intent');
    return {
        taskClass: string(input, 'taskClass', 'intent'),
        ...(input.patterns === undefined ? {} : { patterns: stringArray(input.patterns, 'intent.patterns') }),
        ...optionalString(input, 'originalRequest', 'intent') === undefined ? {} : { originalRequest: optionalString(input, 'originalRequest', 'intent') },
        ...(input.reusableFor === undefined ? {} : { reusableFor: stringArray(input.reusableFor, 'intent.reusableFor') }),
        ...(input.notFor === undefined ? {} : { notFor: stringArray(input.notFor, 'intent.notFor') }),
    };
}
function inputs(value) {
    if (value === undefined)
        return undefined;
    const input = record(value, 'inputs');
    exact(input, ['description', 'examples'], 'inputs');
    return {
        description: string(input, 'description', 'inputs'),
        ...(input.examples === undefined ? {} : {
            examples: Array.isArray(input.examples)
                ? input.examples.map((example, index) => validateJson(example, `inputs.examples.${index}`))
                : (() => { throw new TypeError('inputs.examples must be an array'); })(),
        }),
    };
}
function requirements(value) {
    if (value === undefined)
        return undefined;
    const input = record(value, 'requires');
    exact(input, ['environment', 'tools', 'mcp', 'skills', 'modelTiers', 'userInteraction'], 'requires');
    const environment = input.environment === undefined ? undefined : stringArray(input.environment, 'requires.environment');
    if (environment?.some(item => !ENV_REQUIREMENTS.has(item)))
        throw new TypeError('requires.environment contains an unsupported requirement');
    const modelTiers = input.modelTiers === undefined ? undefined : stringArray(input.modelTiers, 'requires.modelTiers');
    if (modelTiers?.some(item => !MODEL_HINTS.has(item)))
        throw new TypeError('requires.modelTiers contains an unsupported tier');
    const userInteraction = boolean(input, 'userInteraction', 'requires', true);
    return {
        ...(environment === undefined ? {} : { environment: environment }),
        ...(input.tools === undefined ? {} : { tools: stringArray(input.tools, 'requires.tools') }),
        ...(input.mcp === undefined ? {} : { mcp: stringArray(input.mcp, 'requires.mcp') }),
        ...(input.skills === undefined ? {} : { skills: stringArray(input.skills, 'requires.skills') }),
        ...(modelTiers === undefined ? {} : { modelTiers: modelTiers }),
        ...(userInteraction === undefined ? {} : { userInteraction }),
    };
}
function provenance(value) {
    if (value === undefined)
        return undefined;
    const input = record(value, 'provenance');
    exact(input, ['fromRunId', 'fromWorkflowName', 'revisionOf', 'replacesWorkflowName', 'createdAt', 'dshVersion', 'pluginVersion'], 'provenance');
    const out = {
        createdAt: string(input, 'createdAt', 'provenance'),
        dshVersion: string(input, 'dshVersion', 'provenance'),
        pluginVersion: string(input, 'pluginVersion', 'provenance'),
    };
    for (const key of ['fromRunId', 'fromWorkflowName', 'revisionOf', 'replacesWorkflowName']) {
        const value_ = optionalString(input, key, 'provenance');
        if (value_ !== undefined)
            Object.assign(out, { [key]: value_ });
    }
    return out;
}
export function validateWorkflowCapsule(value, limits) {
    const input = record(value, 'workflow capsule');
    exact(input, ['format', 'version', 'workflowApiVersion', 'minDshVersion', 'manifest', 'source', 'intent', 'inputs', 'requires', 'provenance'], 'workflow capsule');
    if (input.format !== DSH_WORKFLOW_FORMAT)
        throw new TypeError(`workflow capsule format must be "${DSH_WORKFLOW_FORMAT}"`);
    if (input.version !== DSH_WORKFLOW_VERSION)
        throw new TypeError(`workflow capsule version must be ${DSH_WORKFLOW_VERSION}`);
    if (input.workflowApiVersion !== DSH_WORKFLOW_API_VERSION)
        throw new TypeError(`workflow capsule workflowApiVersion must be ${DSH_WORKFLOW_API_VERSION}`);
    const source = string(input, 'source', 'workflow capsule');
    return Object.freeze({
        format: DSH_WORKFLOW_FORMAT,
        version: DSH_WORKFLOW_VERSION,
        workflowApiVersion: DSH_WORKFLOW_API_VERSION,
        minDshVersion: string(input, 'minDshVersion', 'workflow capsule'),
        manifest: validateWorkflowManifest(input.manifest, limits),
        source,
        ...intent(input.intent) === undefined ? {} : { intent: intent(input.intent) },
        ...inputs(input.inputs) === undefined ? {} : { inputs: inputs(input.inputs) },
        ...requirements(input.requires) === undefined ? {} : { requires: requirements(input.requires) },
        ...provenance(input.provenance) === undefined ? {} : { provenance: provenance(input.provenance) },
    });
}
function validateAgainst(schema, value, path) {
    if ('const' in schema && schema.const !== undefined && value !== schema.const)
        throw new TypeError(`${path} must equal ${JSON.stringify(schema.const)}`);
    switch (schema.type) {
        case 'json':
            validateJson(value, path);
            return;
        case 'string':
            if (typeof value !== 'string')
                throw new TypeError(`${path} must be a string`);
            if (schema.enum !== undefined && !schema.enum.includes(value))
                throw new TypeError(`${path} must be one of ${schema.enum.join(', ')}`);
            return;
        case 'number':
            if (typeof value !== 'number' || !Number.isFinite(value))
                throw new TypeError(`${path} must be a number`);
            return;
        case 'integer':
            if (typeof value !== 'number' || !Number.isSafeInteger(value))
                throw new TypeError(`${path} must be an integer`);
            return;
        case 'boolean':
            if (typeof value !== 'boolean')
                throw new TypeError(`${path} must be a boolean`);
            return;
        case 'array':
            if (!Array.isArray(value))
                throw new TypeError(`${path} must be an array`);
            value.forEach((item, index) => validateAgainst(schema.items, item, `${path}.${index}`));
            return;
        case 'object': {
            const object = record(value, path);
            for (const key of schema.required ?? [])
                if (!(key in object))
                    throw new TypeError(`${path}.${key} is required`);
            for (const [key, item] of Object.entries(object)) {
                const child = schema.properties?.[key];
                if (child === undefined) {
                    if (schema.additionalProperties === false)
                        throw new TypeError(`${path}.${key} is not allowed`);
                }
                else
                    validateAgainst(child, item, `${path}.${key}`);
            }
        }
    }
}
export function validateWorkflowArgs(capsule, args) {
    if (capsule.manifest.inputSchema !== undefined)
        validateAgainst(capsule.manifest.inputSchema, args, 'args');
    else
        validateJson(args ?? null, 'args');
}
export function createWorkflowCapsule(input) {
    return validateWorkflowCapsule({
        format: DSH_WORKFLOW_FORMAT,
        version: DSH_WORKFLOW_VERSION,
        workflowApiVersion: DSH_WORKFLOW_API_VERSION,
        ...input,
    });
}
