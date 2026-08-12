import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const compatibility = JSON.parse(readFileSync(new URL('../compatibility.json', import.meta.url), 'utf8'))
const snapshot = resolve(process.env.DSH_SNAPSHOT_DIR ?? '../test-icetomoyo')
const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: snapshot, encoding: 'utf8' }).trim()

if (actual !== compatibility.commit) {
  throw new Error(`DSH snapshot mismatch: expected ${compatibility.commit}, got ${actual}`)
}

const packageJson = JSON.parse(readFileSync(resolve(snapshot, 'package.json'), 'utf8'))
if (packageJson.version !== compatibility.version) {
  throw new Error(`DSH version mismatch: expected ${compatibility.version}, got ${packageJson.version}`)
}

process.stdout.write(`DSH compatibility pin verified: ${compatibility.branch}@${actual.slice(0, 12)}\n`)
