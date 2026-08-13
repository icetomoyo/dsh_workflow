import { Script } from 'node:vm'

export class WorkflowScriptError extends Error {
  readonly fatal: boolean

  constructor(message: string, options?: ErrorOptions & { readonly fatal?: boolean }) {
    super(message, options)
    this.name = 'WorkflowScriptError'
    this.fatal = options?.fatal ?? false
  }
}

const FORBIDDEN = [
  ['import', /\bimport\s*(?:\(|['"*{]|\w+\s+from\b)/u],
  ['require', /\brequire\s*\(/u],
  ['process', /\bprocess\s*(?:\.|\[)/u],
  ['filesystem', /\b(?:node:)?fs\b/u],
  ['child_process', /\bchild_process\b/u],
  ['shell', /\b(?:exec|execFile|spawn)\s*\(/u],
  ['network', /\b(?:fetch|WebSocket|XMLHttpRequest)\s*(?:\.|\()/u],
  ['runtime', /\b(?:Deno|Bun)\s*(?:\.|\[)/u],
  ['timers', /\b(?:setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(/u],
  ['dynamic-global', /\bglobalThis\s*\[/u],
  ['internal-bridge', /\b__dsh[A-Za-z0-9_$]*/u],
  ['dynamic-code', /\b(?:eval|Function)\s*\(|\.\s*constructor\b|\b__proto__\b/u],
] as const

function stripLiterals(source: string): string {
  let output = ''
  let index = 0
  let state: 'code' | 'single' | 'double' | 'template' | 'line-comment' | 'block-comment' = 'code'
  let interpolationDepth = 0
  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]
    if (state === 'line-comment') {
      if (char === '\n') { state = 'code'; output += '\n' } else output += ' '
      index += 1
      continue
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') { output += '  '; index += 2; state = 'code' } else { output += char === '\n' ? '\n' : ' '; index += 1 }
      continue
    }
    if (state === 'single' || state === 'double') {
      const quote = state === 'single' ? "'" : '"'
      output += char === '\n' ? '\n' : ' '
      index += 1
      if (char === '\\' && index < source.length) { output += source[index] === '\n' ? '\n' : ' '; index += 1 }
      else if (char === quote) state = 'code'
      continue
    }
    if (state === 'template') {
      if (char === '\\') { output += '  '; index += 2; continue }
      if (char === '`') { output += ' '; index += 1; state = 'code'; continue }
      if (char === '$' && next === '{') { output += '  '; index += 2; state = 'code'; interpolationDepth = 1; continue }
      output += char === '\n' ? '\n' : ' '
      index += 1
      continue
    }
    if (interpolationDepth > 0) {
      if (char === '{') interpolationDepth += 1
      if (char === '}') {
        interpolationDepth -= 1
        if (interpolationDepth === 0) { output += ' '; index += 1; state = 'template'; continue }
      }
    }
    if (char === '/' && next === '/') { output += '  '; index += 2; state = 'line-comment'; continue }
    if (char === '/' && next === '*') { output += '  '; index += 2; state = 'block-comment'; continue }
    if (char === "'") { output += ' '; index += 1; state = 'single'; continue }
    if (char === '"') { output += ' '; index += 1; state = 'double'; continue }
    if (char === '`') { output += ' '; index += 1; state = 'template'; continue }
    output += char
    index += 1
  }
  return output
}

export function validateRestrictedWorkflowSource(source: string, filename = 'workflow.js'): void {
  if (typeof source !== 'string' || source.trim().length === 0) throw new WorkflowScriptError('workflow source must be a non-empty string')
  if (!/\basync\s+function\s+run\s*\(\s*wf\s*,\s*args\s*\)/u.test(source)) {
    throw new WorkflowScriptError('restricted workflow source must define async function run(wf, args)')
  }
  if (/\[\s*(['"])constructor\1\s*\]/u.test(source)) throw new WorkflowScriptError('forbidden restricted workflow token: dynamic-code')
  const stripped = stripLiterals(source)
  for (const [name, pattern] of FORBIDDEN) {
    if (pattern.test(stripped)) throw new WorkflowScriptError(`forbidden restricted workflow token: ${name}`)
  }
  try {
    new Script(`"use strict";\n${source}\nvoid run`, { filename })
  } catch (error) {
    throw new WorkflowScriptError(`restricted workflow source failed to compile: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

export interface WorkflowQualityFinding {
  readonly code: string
  readonly message: string
}

export function lintRestrictedWorkflowSource(source: string): readonly WorkflowQualityFinding[] {
  const findings: WorkflowQualityFinding[] = []
  if (!/\bwf\.(?:runAgent|spawnAgent|workflow)\s*\(/u.test(source)) findings.push({ code: 'NO_AGENT_WORK', message: 'workflow launches no agent or nested workflow' })
  if (/\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)/u.test(stripLiterals(source))) findings.push({ code: 'UNBOUNDED_LOOP', message: 'workflow contains an obviously unbounded loop' })
  if (/\bwf\.spawnAgent\s*\(/u.test(source) && !/\bwf\.(?:wait|snapshot|stop|send)\s*\(/u.test(source)) findings.push({ code: 'UNOBSERVED_TASK', message: 'spawned tasks are never observed' })
  if (/(?<!\bawait\s+)\bwf\.runAgent\s*\(/u.test(stripLiterals(source))) findings.push({ code: 'UNAWAITED_AGENT', message: 'runAgent is called without awaiting its result' })
  return findings
}

export function assertRestrictedWorkflowQuality(source: string): void {
  const hard = lintRestrictedWorkflowSource(source).filter(item => item.code === 'UNBOUNDED_LOOP')
  if (hard.length > 0) throw new WorkflowScriptError(hard.map(item => `${item.code}: ${item.message}`).join('; '))
}
