import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
const SAFE_ID = /^[a-zA-Z0-9._-]+$/u;
const TERMINAL = new Set(['completed', 'failed', 'denied', 'stopped']);
function safePart(value, label) {
    if (!SAFE_ID.test(value) || value === '.' || value === '..' || value.includes('..'))
        throw new Error(`${label} is unsafe`);
    return value;
}
function contained(root, child) {
    const absoluteRoot = resolve(root);
    const target = resolve(absoluteRoot, child);
    if (!target.startsWith(`${absoluteRoot}${sep}`))
        throw new Error('workflow store path escaped its root');
    return target;
}
function json(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}
function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}
function artifactFilename(name) {
    const cleaned = name.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 120);
    const identity = createHash('sha256').update(name).digest('hex').slice(0, 16);
    return `${cleaned.length === 0 ? 'artifact' : cleaned}-${identity}.json`;
}
export class WorkflowRunStore {
    root;
    now;
    constructor(root, now = () => Date.now(), owner) {
        this.root = root;
        this.now = now;
        mkdirSync(root, { recursive: true });
        if (owner !== undefined) {
            const marker = join(root, '.project.json');
            if (!existsSync(marker)) {
                try {
                    writeFileSync(marker, json({ canonicalProjectDirectory: owner }), { encoding: 'utf8', flag: 'wx' });
                }
                catch (error) {
                    if (error.code !== 'EEXIST')
                        throw error;
                }
            }
            const recorded = readJson(marker).canonicalProjectDirectory;
            if (recorded !== owner)
                throw new Error(`workflow run partition belongs to a different project: ${recorded ?? 'unknown'}`);
        }
    }
    runDir(runId) {
        return contained(this.root, safePart(runId, 'run id'));
    }
    create(runId) {
        const runDir = this.runDir(runId);
        mkdirSync(join(runDir, 'artifacts'), { recursive: true });
        mkdirSync(join(runDir, 'results'), { recursive: true });
        let sequence = 0;
        const artifactNames = new Set();
        const events = join(runDir, 'events.jsonl');
        const cachePath = (key) => join(runDir, 'results', `${safePart(key, 'cache key')}.json`);
        return {
            runId,
            runDir,
            append: (type, data) => {
                const event = { seq: sequence++, time: this.now(), type, data };
                appendFileSync(events, `${JSON.stringify(event)}\n`, 'utf8');
                return event;
            },
            artifact: (name, value) => {
                if (artifactNames.has(name))
                    throw new Error(`workflow artifact "${name}" was already written`);
                const path = join(runDir, 'artifacts', artifactFilename(name));
                writeFileSync(path, json(value), { encoding: 'utf8', flag: 'wx' });
                artifactNames.add(name);
                return { name, path };
            },
            snapshotScript: (capsule) => {
                writeFileSync(join(runDir, 'workflow.workflow.json'), json(capsule), 'utf8');
                writeFileSync(join(runDir, 'script.js'), `${capsule.source}\n`, 'utf8');
                writeFileSync(join(runDir, 'manifest.json'), json(capsule.manifest), 'utf8');
            },
            writeSnapshot: snapshot => writeFileSync(join(runDir, 'run.json'), json(snapshot), 'utf8'),
            cacheKey: (input, occurrence) => {
                const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32);
                return `${hash}-${occurrence}`;
            },
            getCached: (key, priorRunId) => {
                const own = cachePath(key);
                if (existsSync(own))
                    return readJson(own);
                if (priorRunId === undefined)
                    return undefined;
                const prior = join(this.runDir(priorRunId), 'results', `${safePart(key, 'cache key')}.json`);
                if (!existsSync(prior))
                    return undefined;
                const result = readJson(prior);
                if (result.status !== 'completed' || (result.verificationWarnings?.length ?? 0) > 0)
                    return undefined;
                writeFileSync(own, json(result), 'utf8');
                return result;
            },
            setCached: (key, result) => writeFileSync(cachePath(key), json(result), 'utf8'),
        };
    }
    get(runId) {
        const path = join(this.runDir(runId), 'run.json');
        return existsSync(path) ? readJson(path) : undefined;
    }
    getCapsule(runId) {
        const path = join(this.runDir(runId), 'workflow.workflow.json');
        return existsSync(path) ? readJson(path) : undefined;
    }
    getEvents(runId) {
        const path = join(this.runDir(runId), 'events.jsonl');
        if (!existsSync(path))
            return [];
        return readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
    }
    list() {
        if (!existsSync(this.root))
            return [];
        const snapshots = [];
        for (const entry of readdirSync(this.root, { withFileTypes: true })) {
            if (!entry.isDirectory() || !SAFE_ID.test(entry.name))
                continue;
            try {
                const snapshot = this.get(entry.name);
                if (snapshot !== undefined)
                    snapshots.push(snapshot);
            }
            catch { /* one corrupt record must not hide healthy runs */ }
        }
        return snapshots.sort((a, b) => b.startedAt - a.startedAt);
    }
    resolveIdentity(target) {
        if (SAFE_ID.test(target)) {
            const exact = this.get(target);
            if (exact !== undefined)
                return { kind: 'run', runId: target, snapshot: exact };
        }
        const aliases = this.list().filter(item => item.displayName === target);
        if (aliases.length === 1)
            return { kind: 'run', runId: aliases[0].runId, snapshot: aliases[0] };
        if (aliases.length > 1)
            return { kind: 'ambiguous', target, runIds: aliases.map(item => item.runId) };
        return { kind: 'missing', target };
    }
    rename(runId, displayName) {
        if (displayName.trim().length === 0)
            throw new Error('workflow display name must be non-empty');
        const snapshot = this.get(runId);
        if (snapshot === undefined)
            throw new Error(`workflow run "${runId}" was not found`);
        const next = { ...snapshot, displayName: displayName.trim() };
        writeFileSync(join(this.runDir(runId), 'run.json'), json(next), 'utf8');
        return next;
    }
    delete(runId, force = false) {
        const snapshot = this.get(runId);
        if (snapshot === undefined)
            throw new Error(`workflow run "${runId}" was not found`);
        if (!force && !TERMINAL.has(snapshot.status))
            throw new Error(`workflow run "${runId}" is not terminal; use force only for a stale record`);
        rmSync(this.runDir(runId), { recursive: true });
    }
    prune(options) {
        const terminal = this.list().filter(item => TERMINAL.has(item.status));
        const keep = options.keep ?? 100;
        if (!Number.isSafeInteger(keep) || keep < 0)
            throw new Error('prune keep must be a non-negative safe integer');
        const retained = terminal.slice(0, keep);
        const threshold = options.olderThanMs === undefined ? undefined : this.now() - options.olderThanMs;
        const candidates = terminal.filter(item => !retained.includes(item) && (threshold === undefined || (item.endedAt ?? item.startedAt) < threshold)).map(item => item.runId);
        if (options.dryRun !== true)
            for (const runId of candidates)
                this.delete(runId);
        return { candidates, deleted: options.dryRun === true ? [] : candidates };
    }
    archiveRun(runId, archiveRoot) {
        const source = this.runDir(runId);
        const target = contained(archiveRoot, basename(source));
        mkdirSync(archiveRoot, { recursive: true });
        renameSync(source, target);
        return target;
    }
}
