import { createHash } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type {
  WorkflowArtifactRef, WorkflowCapsule, WorkflowEvent, WorkflowRunSnapshot,
  WorkflowTaskResult,
} from './types.js'

const SAFE_ID = /^[a-zA-Z0-9._-]+$/u
const TERMINAL = new Set(['completed', 'failed', 'denied', 'stopped'])

function safePart(value: string, label: string): string {
  if (!SAFE_ID.test(value) || value === '.' || value === '..' || value.includes('..')) throw new Error(`${label} is unsafe`)
  return value
}

function contained(root: string, child: string): string {
  const absoluteRoot = resolve(root)
  const target = resolve(absoluteRoot, child)
  if (!target.startsWith(`${absoluteRoot}${sep}`)) throw new Error('workflow store path escaped its root')
  return target
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function artifactFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 120)
  const identity = createHash('sha256').update(name).digest('hex').slice(0, 16)
  return `${cleaned.length === 0 ? 'artifact' : cleaned}-${identity}.json`
}

export interface WorkflowRunWriter {
  readonly runId: string
  readonly runDir: string
  append(type: WorkflowEvent['type'], data: WorkflowEvent['data']): WorkflowEvent
  artifact(name: string, value: unknown): WorkflowArtifactRef
  snapshotScript(capsule: WorkflowCapsule): void
  writeSnapshot(snapshot: WorkflowRunSnapshot): void
  cacheKey(input: unknown, occurrence: number): string
  getCached(key: string, priorRunId?: string): WorkflowTaskResult | undefined
  setCached(key: string, result: WorkflowTaskResult): void
}

export interface WorkflowPruneOptions {
  readonly keep?: number
  readonly olderThanMs?: number
  readonly dryRun?: boolean
}

export interface WorkflowPruneResult {
  readonly candidates: readonly string[]
  readonly deleted: readonly string[]
}

export type WorkflowIdentityResolution =
  | { readonly kind: 'run'; readonly runId: string; readonly snapshot: WorkflowRunSnapshot }
  | { readonly kind: 'ambiguous'; readonly target: string; readonly runIds: readonly string[] }
  | { readonly kind: 'missing'; readonly target: string }

export class WorkflowRunStore {
  constructor(readonly root: string, private readonly now: () => number = () => Date.now(), owner?: string) {
    mkdirSync(root, { recursive: true })
    if (owner !== undefined) {
      const marker = join(root, '.project.json')
      if (!existsSync(marker)) {
        try { writeFileSync(marker, json({ canonicalProjectDirectory: owner }), { encoding: 'utf8', flag: 'wx' }) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      const recorded = readJson<{ readonly canonicalProjectDirectory?: string }>(marker).canonicalProjectDirectory
      if (recorded !== owner) throw new Error(`workflow run partition belongs to a different project: ${recorded ?? 'unknown'}`)
    }
  }

  runDir(runId: string): string {
    return contained(this.root, safePart(runId, 'run id'))
  }

  create(runId: string): WorkflowRunWriter {
    const runDir = this.runDir(runId)
    mkdirSync(join(runDir, 'artifacts'), { recursive: true })
    mkdirSync(join(runDir, 'results'), { recursive: true })
    let sequence = 0
    const artifactNames = new Set<string>()
    const events = join(runDir, 'events.jsonl')
    const cachePath = (key: string): string => join(runDir, 'results', `${safePart(key, 'cache key')}.json`)
    return {
      runId,
      runDir,
      append: (type, data) => {
        const event: WorkflowEvent = { seq: sequence++, time: this.now(), type, data }
        appendFileSync(events, `${JSON.stringify(event)}\n`, 'utf8')
        return event
      },
      artifact: (name, value) => {
        if (artifactNames.has(name)) throw new Error(`workflow artifact "${name}" was already written`)
        const path = join(runDir, 'artifacts', artifactFilename(name))
        writeFileSync(path, json(value), { encoding: 'utf8', flag: 'wx' })
        artifactNames.add(name)
        return { name, path }
      },
      snapshotScript: (capsule) => {
        writeFileSync(join(runDir, 'workflow.workflow.json'), json(capsule), 'utf8')
        writeFileSync(join(runDir, 'script.js'), `${capsule.source}\n`, 'utf8')
        writeFileSync(join(runDir, 'manifest.json'), json(capsule.manifest), 'utf8')
      },
      writeSnapshot: snapshot => writeFileSync(join(runDir, 'run.json'), json(snapshot), 'utf8'),
      cacheKey: (input, occurrence) => {
        const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32)
        return `${hash}-${occurrence}`
      },
      getCached: (key, priorRunId) => {
        const own = cachePath(key)
        if (existsSync(own)) return readJson<WorkflowTaskResult>(own)
        if (priorRunId === undefined) return undefined
        const prior = join(this.runDir(priorRunId), 'results', `${safePart(key, 'cache key')}.json`)
        if (!existsSync(prior)) return undefined
        const result = readJson<WorkflowTaskResult>(prior)
        if (result.status !== 'completed' || (result.verificationWarnings?.length ?? 0) > 0) return undefined
        writeFileSync(own, json(result), 'utf8')
        return result
      },
      setCached: (key, result) => writeFileSync(cachePath(key), json(result), 'utf8'),
    }
  }

  get(runId: string): WorkflowRunSnapshot | undefined {
    const path = join(this.runDir(runId), 'run.json')
    return existsSync(path) ? readJson<WorkflowRunSnapshot>(path) : undefined
  }

  getCapsule(runId: string): WorkflowCapsule | undefined {
    const path = join(this.runDir(runId), 'workflow.workflow.json')
    return existsSync(path) ? readJson<WorkflowCapsule>(path) : undefined
  }

  getEvents(runId: string): readonly WorkflowEvent[] {
    const path = join(this.runDir(runId), 'events.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as WorkflowEvent)
  }

  list(): readonly WorkflowRunSnapshot[] {
    if (!existsSync(this.root)) return []
    const snapshots: WorkflowRunSnapshot[] = []
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue
      try {
        const snapshot = this.get(entry.name)
        if (snapshot !== undefined) snapshots.push(snapshot)
      } catch { /* one corrupt record must not hide healthy runs */ }
    }
    return snapshots.sort((a, b) => b.startedAt - a.startedAt)
  }

  resolveIdentity(target: string): WorkflowIdentityResolution {
    if (SAFE_ID.test(target)) {
      const exact = this.get(target)
      if (exact !== undefined) return { kind: 'run', runId: target, snapshot: exact }
    }
    const aliases = this.list().filter(item => item.displayName === target)
    if (aliases.length === 1) return { kind: 'run', runId: aliases[0]!.runId, snapshot: aliases[0]! }
    if (aliases.length > 1) return { kind: 'ambiguous', target, runIds: aliases.map(item => item.runId) }
    return { kind: 'missing', target }
  }

  rename(runId: string, displayName: string): WorkflowRunSnapshot {
    if (displayName.trim().length === 0) throw new Error('workflow display name must be non-empty')
    const snapshot = this.get(runId)
    if (snapshot === undefined) throw new Error(`workflow run "${runId}" was not found`)
    const next = { ...snapshot, displayName: displayName.trim() }
    writeFileSync(join(this.runDir(runId), 'run.json'), json(next), 'utf8')
    return next
  }

  delete(runId: string, force = false): void {
    const snapshot = this.get(runId)
    if (snapshot === undefined) throw new Error(`workflow run "${runId}" was not found`)
    if (!force && !TERMINAL.has(snapshot.status)) throw new Error(`workflow run "${runId}" is not terminal; use force only for a stale record`)
    rmSync(this.runDir(runId), { recursive: true })
  }

  prune(options: WorkflowPruneOptions): WorkflowPruneResult {
    const terminal = this.list().filter(item => TERMINAL.has(item.status))
    const keep = options.keep ?? 100
    if (!Number.isSafeInteger(keep) || keep < 0) throw new Error('prune keep must be a non-negative safe integer')
    const retained = terminal.slice(0, keep)
    const threshold = options.olderThanMs === undefined ? undefined : this.now() - options.olderThanMs
    const candidates = terminal.filter(item => !retained.includes(item) && (threshold === undefined || (item.endedAt ?? item.startedAt) < threshold)).map(item => item.runId)
    if (options.dryRun !== true) for (const runId of candidates) this.delete(runId)
    return { candidates, deleted: options.dryRun === true ? [] : candidates }
  }

  archiveRun(runId: string, archiveRoot: string): string {
    const source = this.runDir(runId)
    const target = contained(archiveRoot, basename(source))
    mkdirSync(archiveRoot, { recursive: true })
    renameSync(source, target)
    return target
  }
}
