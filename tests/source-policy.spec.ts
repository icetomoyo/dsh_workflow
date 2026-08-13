import { describe, expect, it } from 'vitest'
import { assertRestrictedWorkflowQuality, lintRestrictedWorkflowSource, validateRestrictedWorkflowSource } from '../src/source-policy.js'

const wrap = (body: string): string => `async function run(wf, args) { ${body} }`

describe('restricted source policy', () => {
  it.each([
    ['require', 'return require("x")'],
    ['filesystem', 'return fs.readFileSync("x")'],
    ['child_process', 'return child_process.exec("x")'],
    ['shell', 'return execFile("x")'],
    ['network', 'return new WebSocket("x")'],
    ['runtime', 'return Deno.cwd()'],
    ['runtime', 'return Bun.file("x")'],
    ['timers', 'return queueMicrotask(() => {})'],
    ['dynamic-global', 'return globalThis["process"]'],
    ['internal-bridge', 'return __dshSync("parallelEnd", "{}")'],
    ['dynamic-code', 'return Function("return process")()'],
    ['dynamic-code', 'return this.constructor.constructor("return process")()'],
    ['dynamic-code', 'return ({})["constructor"]'],
    ['dynamic-code', 'return ({ __proto__: null })'],
  ])('blocks the %s capability family', (name, body) => {
    expect(() => validateRestrictedWorkflowSource(wrap(body))).toThrow(new RegExp(`forbidden restricted workflow token: ${name}`, 'u'))
  })

  it('ignores dangerous words in every literal/comment state but checks template interpolation', () => {
    const safe = wrap(`
      // process.cwd() and require('x')
      /* fetch('x') and fs.readFileSync('x') */
      const one = 'process.cwd() \\' still text';
      const two = "require(\\\"x\\\")";
      const three = \`fetch('x') plain template\`;
      return await wf.runAgent({ name: 'safe', prompt: one + two + three });
    `)
    expect(() => validateRestrictedWorkflowSource(safe)).not.toThrow()
    expect(() => validateRestrictedWorkflowSource(wrap('return `value ${process.cwd()}`'))).toThrow(/process/u)
  })

  it('reports compile and contract errors with stable diagnostics', () => {
    expect(() => validateRestrictedWorkflowSource('')).toThrow(/non-empty/u)
    expect(() => validateRestrictedWorkflowSource('async function other() {}')).toThrow(/define async function run/u)
    expect(() => validateRestrictedWorkflowSource(wrap('return ('))).toThrow(/failed to compile/u)
  })

  it('lints missing work, unbounded loops, and unobserved spawned tasks', () => {
    expect(lintRestrictedWorkflowSource(wrap('return args'))).toEqual([expect.objectContaining({ code: 'NO_AGENT_WORK' })])
    expect(lintRestrictedWorkflowSource(wrap('const task = await wf.spawnAgent({ name: "x", prompt: "x" }); return task'))).toEqual([expect.objectContaining({ code: 'UNOBSERVED_TASK' })])
    const looping = wrap('while (true) { await wf.runAgent({ name: "x", prompt: "x" }); }')
    expect(lintRestrictedWorkflowSource(looping)).toEqual([expect.objectContaining({ code: 'UNBOUNDED_LOOP' })])
    expect(() => assertRestrictedWorkflowQuality(looping)).toThrow(/UNBOUNDED_LOOP/u)
    expect(() => assertRestrictedWorkflowQuality(wrap('return await wf.runAgent({ name: "x", prompt: "x" })'))).not.toThrow()
  })
})
