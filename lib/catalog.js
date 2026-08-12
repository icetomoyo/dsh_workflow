import { link, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateWorkflowCapsule, validateWorkflowManifest } from './capsule.js';
const CAPSULE_SUFFIX = '.workflow.json';
const TRUSTED_SUFFIXES = ['.ts', '.mjs', '.js'];
const SAFE_NAME = /^[a-z][a-z0-9-]{0,63}$/u;
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function sourceEntry(module, source) {
    return {
        name: module.manifest.name,
        source,
        execution: 'trusted-package',
        description: module.manifest.description,
        manifest: module.manifest,
        valid: true,
    };
}
function suffixOf(file) {
    if (file.endsWith(CAPSULE_SUFFIX))
        return CAPSULE_SUFFIX;
    return TRUSTED_SUFFIXES.find(suffix => file.endsWith(suffix));
}
function nameOf(file, suffix) {
    return basename(file).slice(0, -suffix.length);
}
async function discoverDirectory(directory, source, options) {
    let files;
    try {
        files = await readdir(directory);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    const candidates = new Map();
    for (const file of files.sort()) {
        const suffix = suffixOf(file);
        if (suffix === undefined)
            continue;
        const name = nameOf(file, suffix);
        if (!SAFE_NAME.test(name))
            continue;
        const previous = candidates.get(name);
        if (previous === undefined || suffix === CAPSULE_SUFFIX)
            candidates.set(name, { file, suffix });
    }
    const entries = [];
    for (const [name, candidate] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
        const path = join(directory, candidate.file);
        try {
            const stat = await lstat(path);
            if (!stat.isFile() || stat.isSymbolicLink())
                continue;
            if (stat.size > options.maxCapsuleBytes)
                throw new Error(`workflow file exceeds ${options.maxCapsuleBytes} bytes`);
            if (candidate.suffix === CAPSULE_SUFFIX) {
                const capsule = validateWorkflowCapsule(JSON.parse(await readFile(path, 'utf8')), options);
                if (capsule.manifest.name !== name)
                    throw new Error(`manifest.name "${capsule.manifest.name}" must match filename "${name}"`);
                entries.push({
                    name,
                    source,
                    execution: 'capability-generated',
                    path,
                    description: capsule.manifest.description,
                    manifest: capsule.manifest,
                    valid: true,
                });
            }
            else {
                entries.push({ name, source, execution: 'trusted-local', path, valid: true });
            }
        }
        catch (error) {
            entries.push({ name, source, execution: candidate.suffix === CAPSULE_SUFFIX ? 'capability-generated' : 'trusted-local', path, valid: false, error: errorMessage(error) });
        }
    }
    return entries;
}
export async function discoverWorkflowCatalog(options) {
    const [project, personal] = await Promise.all([
        discoverDirectory(options.project, 'project', options),
        discoverDirectory(options.personal, 'personal', options),
    ]);
    const selected = new Map();
    for (const module of options.builtins ?? [])
        selected.set(module.manifest.name, sourceEntry(module, 'built-in'));
    for (const module of options.patterns ?? [])
        if (!selected.has(module.manifest.name))
            selected.set(module.manifest.name, sourceEntry(module, 'pattern'));
    for (const entry of personal)
        if (!selected.has(entry.name))
            selected.set(entry.name, entry);
    for (const entry of project) {
        const existing = selected.get(entry.name);
        if (existing?.source === 'built-in' || existing?.source === 'pattern')
            continue;
        selected.set(entry.name, entry);
    }
    const all = [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
    const max = options.maxEntries ?? Number.MAX_SAFE_INTEGER;
    return { entries: all.slice(0, max), truncated: all.length > max };
}
async function importTrusted(path) {
    const stat = await lstat(path);
    // Node >=22.19 performs native erasable-syntax TypeScript stripping for
    // .ts modules, preserving ordinary file-URL relative import semantics.
    const url = pathToFileURL(path).href;
    return await import(extname(path) === '.ts' ? url : `${url}?mtime=${String(stat.mtimeMs)}`);
}
function trustedManifest(value, limits) {
    if (typeof value !== 'object' || value === null)
        throw new Error('trusted workflow meta must be an object');
    const input = value;
    return validateWorkflowManifest({
        name: input.name,
        description: input.description,
        phases: input.phases ?? ['run'],
        readOnly: input.readOnly ?? false,
        plannedAgents: input.plannedAgents,
        maxAgents: input.maxAgents ?? limits.maxAgents,
        maxConcurrency: input.maxConcurrency ?? limits.maxConcurrency,
        tokenBudget: input.tokenBudget,
        mayUseWorktree: input.mayUseWorktree,
        patterns: input.patterns ?? ['fan-out-and-synthesize'],
        inputSchema: input.inputSchema,
    }, limits);
}
export async function loadWorkflowByName(options, name, allowTrustedLocal = false) {
    if (!SAFE_NAME.test(name))
        throw new Error(`invalid workflow name "${name}"`);
    const builtin = options.builtins?.find(module => module.manifest.name === name);
    if (builtin !== undefined)
        return { module: builtin, source: 'built-in', execution: 'trusted-package' };
    const pattern = options.patterns?.find(module => module.manifest.name === name);
    if (pattern !== undefined)
        return { module: pattern, source: 'pattern', execution: 'trusted-package' };
    const catalog = await discoverWorkflowCatalog({ ...options, maxEntries: Number.MAX_SAFE_INTEGER });
    const entry = catalog.entries.find(item => item.name === name);
    if (entry === undefined)
        throw new Error(`workflow "${name}" was not found`);
    if (!entry.valid || entry.path === undefined)
        throw new Error(`workflow "${name}" is invalid: ${entry.error ?? 'unknown error'}`);
    if (entry.execution === 'capability-generated') {
        const capsule = validateWorkflowCapsule(JSON.parse(await readFile(entry.path, 'utf8')), options);
        return {
            module: { manifest: capsule.manifest, execution: 'capability-generated', source: capsule.source, capsule },
            source: entry.source,
            execution: 'capability-generated',
            path: entry.path,
            capsule,
        };
    }
    if (!allowTrustedLocal)
        throw new Error(`workflow "${name}" is trusted-local and requires explicit approval before loading`);
    const imported = await importTrusted(entry.path);
    const candidate = (imported.default ?? imported);
    const run = candidate.run;
    if (typeof run !== 'function')
        throw new Error(`trusted workflow "${name}" must export a run function`);
    const manifest = trustedManifest(candidate.manifest ?? candidate.meta, options);
    if (manifest.name !== name)
        throw new Error(`trusted workflow name "${manifest.name}" must match filename "${name}"`);
    return {
        module: { manifest, execution: 'trusted-local', run: run },
        source: entry.source,
        execution: 'trusted-local',
        path: entry.path,
    };
}
function safeTarget(directory, name) {
    if (!SAFE_NAME.test(name))
        throw new Error(`invalid workflow name "${name}"`);
    const root = resolve(directory);
    const target = resolve(root, `${name}${CAPSULE_SUFFIX}`);
    if (!target.startsWith(`${root}${sep}`))
        throw new Error('workflow path escaped its catalog directory');
    return target;
}
function comparablePath(path) {
    const normalized = resolve(path).replace(/^\\\\\?\\/u, '');
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}
function isWithin(root, candidate) {
    const result = relative(root, candidate);
    return result === '' || (!result.startsWith(`..${sep}`) && result !== '..' && !isAbsolute(result));
}
async function ensureDirectoryPath(directory, create) {
    const absolute = resolve(directory);
    const parsed = parse(absolute);
    let current = parsed.root;
    const segments = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
    for (const segment of segments) {
        current = join(current, segment);
        let stat;
        try {
            stat = await lstat(current);
        }
        catch (error) {
            if (error.code !== 'ENOENT' || !create)
                throw error;
            try {
                await mkdir(current);
            }
            catch (mkdirError) {
                if (mkdirError.code !== 'EEXIST')
                    throw mkdirError;
            }
            stat = await lstat(current);
        }
        if (stat.isSymbolicLink()) {
            throw new Error(`catalog path contains a symbolic link or reparse point: ${current}`);
        }
        if (!stat.isDirectory())
            throw new Error(`catalog path component is not a directory: ${current}`);
        const canonical = await realpath(current);
        if (comparablePath(canonical) !== comparablePath(current)) {
            throw new Error(`catalog path contains a symbolic link or reparse point: ${current}`);
        }
    }
    const canonical = await realpath(absolute);
    if (comparablePath(canonical) !== comparablePath(absolute)) {
        throw new Error(`catalog path contains a symbolic link or reparse point: ${absolute}`);
    }
    return canonical;
}
async function writableTarget(directory, name, createRoot) {
    if (!SAFE_NAME.test(name))
        throw new Error(`invalid workflow name "${name}"`);
    const root = await ensureDirectoryPath(directory, createRoot);
    const target = safeTarget(root, name);
    const canonicalParent = await realpath(dirname(target));
    if (!isWithin(root, canonicalParent) || comparablePath(canonicalParent) !== comparablePath(root)) {
        throw new Error('workflow parent escaped its canonical catalog directory');
    }
    return { root, target };
}
async function assertSafeLeaf(path) {
    try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink())
            throw new Error(`workflow path is a symbolic link or reparse point: ${path}`);
        if (!stat.isFile())
            throw new Error(`workflow path is not a regular file: ${path}`);
        const canonical = await realpath(path);
        if (comparablePath(canonical) !== comparablePath(path)) {
            throw new Error(`workflow path is a symbolic link or reparse point: ${path}`);
        }
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
async function ensureArchiveDirectory(root) {
    const archive = await ensureDirectoryPath(join(root, '.archive'), true);
    if (!isWithin(root, archive))
        throw new Error('workflow archive escaped its canonical catalog directory');
    return archive;
}
export async function saveWorkflowCapsule(directory, name, capsule, replace = false) {
    const validated = validateWorkflowCapsule(capsule);
    if (validated.manifest.name !== name)
        throw new Error('saved workflow name must match manifest.name');
    const { root, target } = await writableTarget(directory, name, true);
    const exists = await assertSafeLeaf(target);
    if (exists && !replace)
        throw new Error(`saved workflow "${name}" already exists`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let backup;
    try {
        await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        await writableTarget(root, name, false);
        if (!replace) {
            try {
                await link(temporary, target);
            }
            catch (error) {
                if (error.code === 'EEXIST') {
                    await assertSafeLeaf(target);
                    throw new Error(`saved workflow "${name}" already exists`);
                }
                throw error;
            }
            return target;
        }
        if (exists) {
            await assertSafeLeaf(target);
            const archive = await ensureArchiveDirectory(root);
            backup = join(archive, `${name}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}${CAPSULE_SUFFIX}`);
            await rename(target, backup);
        }
        try {
            await rename(temporary, target);
        }
        catch (error) {
            if (backup !== undefined)
                await rename(backup, target);
            throw error;
        }
        return target;
    }
    finally {
        await rm(temporary, { force: true });
    }
}
export async function deleteSavedWorkflow(directory, name) {
    const { target } = await writableTarget(directory, name, false);
    await assertSafeLeaf(target);
    await rm(target);
}
export async function renameSavedWorkflow(directory, from, to) {
    const { root, target: source } = await writableTarget(directory, from, false);
    const { target } = await writableTarget(root, to, false);
    await assertSafeLeaf(source);
    const capsule = validateWorkflowCapsule(JSON.parse(await readFile(source, 'utf8')));
    const next = validateWorkflowCapsule({ ...capsule, manifest: { ...capsule.manifest, name: to } });
    await saveWorkflowCapsule(root, to, next, false);
    await writableTarget(root, from, false);
    await assertSafeLeaf(source);
    await rm(source);
    return target;
}
