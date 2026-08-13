import { getQuickJS, type QuickJSContext, type QuickJSDeferredPromise } from 'quickjs-emscripten'
import { assertRestrictedWorkflowQuality, validateRestrictedWorkflowSource, WorkflowScriptError } from './source-policy.js'
import { WORKFLOW_INTERNAL, type WorkflowApi, type WorkflowBudget, type WorkflowSpawnAgentInput, type WorkflowSynthesis } from './types.js'

export interface RestrictedWorkflowRunOptions {
  readonly source: string
  readonly wf: WorkflowApi
  readonly args?: unknown
  readonly filename?: string
  readonly syncTimeoutMs: number
  readonly wallTimeoutMs: number
  /** Called synchronously when the wall clock expires so the owner can abort child work. */
  readonly onTimeout?: () => void
}

function assertJsonValue(value: unknown, label: string, ancestors: Set<object>, depth = 0): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new WorkflowScriptError(`${label} contains a non-finite number`)
    return
  }
  if (typeof value !== 'object') throw new WorkflowScriptError(`${label} contains a non-JSON ${typeof value} value`)
  if (depth > 200) throw new WorkflowScriptError(`${label} exceeds the JSON nesting limit`)
  if (ancestors.has(value)) throw new WorkflowScriptError(`${label} contains a circular reference`)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value)
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw new WorkflowScriptError(`${label} contains a sparse array or non-index property`)
      }
      for (const item of value) assertJsonValue(item, label, ancestors, depth + 1)
      return
    }
    const prototype = Object.getPrototypeOf(value) as object | null
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
      throw new WorkflowScriptError(`${label} contains a non-plain object`)
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new WorkflowScriptError(`${label} contains a symbol key`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new WorkflowScriptError(`${label} contains an accessor or non-enumerable property`)
      }
      assertJsonValue(descriptor.value, label, ancestors, depth + 1)
    }
  } finally {
    ancestors.delete(value)
  }
}

export function snapshotWorkflowJson<T>(value: T, label: string, allowUndefined = false): T {
  try {
    if (value === undefined) {
      if (allowUndefined) return value
      throw new WorkflowScriptError(`${label} must be a JSON value`)
    }
    assertJsonValue(value, label, new Set())
    return JSON.parse(JSON.stringify(value)) as T
  } catch (error) {
    if (error instanceof WorkflowScriptError) throw error
    throw new WorkflowScriptError(`${label} must be JSON-serializable`, { cause: error })
  }
}

const jsonClone = snapshotWorkflowJson

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new WorkflowScriptError(`${label} must be a non-empty string`)
  return value
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WorkflowScriptError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function controlled<T>(method: string, operation: () => Promise<T>): Promise<T> {
  return operation().then(value => jsonClone(value === undefined ? null : value, `wf.${method} result`) as T, error => {
    const fatal = error instanceof Error && error.name === 'WorkflowControlError'
    throw new WorkflowScriptError(`wf.${method} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error, fatal })
  })
}

function proxyApi(wf: WorkflowApi, args: unknown): WorkflowApi {
  const budget: WorkflowBudget = Object.freeze({
    total: wf.budget.total,
    spent: () => wf.budget.spent(),
    remaining: () => wf.budget.remaining(),
  })
  return Object.freeze({
    runId: wf.runId,
    args: jsonClone(args, 'workflow args', true),
    budget,
    phase: <T>(name: string, fn: () => Promise<T>) => controlled('phase', () => wf.phase(nonEmpty(name, 'phase name'), fn)),
    spawnAgent: (input: WorkflowSpawnAgentInput) => controlled('spawnAgent', () => wf.spawnAgent(jsonClone(object(input, 'spawnAgent input'), 'spawnAgent input') as unknown as WorkflowSpawnAgentInput)),
    runAgent: (input: WorkflowSpawnAgentInput) => controlled('runAgent', () => wf.runAgent(jsonClone(object(input, 'runAgent input'), 'runAgent input') as unknown as WorkflowSpawnAgentInput)),
    wait: (taskId: string, options?: { readonly timeoutMs?: number }) => controlled('wait', () => wf.wait(nonEmpty(taskId, 'taskId'), jsonClone(options, 'wait options', true))),
    snapshot: (taskId: string) => controlled('snapshot', () => wf.snapshot(nonEmpty(taskId, 'taskId'))),
    output: (taskId: string) => controlled('output', () => wf.output(nonEmpty(taskId, 'taskId'))),
    send: (taskId: string, content: string) => controlled('send', () => wf.send(nonEmpty(taskId, 'taskId'), nonEmpty(content, 'content'))),
    stop: (taskId: string, reason: string) => controlled('stop', () => wf.stop(nonEmpty(taskId, 'taskId'), nonEmpty(reason, 'reason'))),
    parallel: async <T>(thunks: readonly (() => Promise<T>)[], options?: { readonly concurrency?: number }): Promise<(T | null)[]> => await wf.parallel(thunks, options),
    pipeline: async <T>(items: readonly T[], ...stages: readonly ((value: unknown, item: T, index: number) => Promise<unknown>)[]): Promise<(unknown | null)[]> => await wf.pipeline(items, ...stages),
    synthesize: (input: { readonly inputs: unknown; readonly rubric: string }): Promise<WorkflowSynthesis> => controlled('synthesize', () => wf.synthesize({ inputs: jsonClone(input.inputs, 'synthesis inputs'), rubric: nonEmpty(input.rubric, 'synthesis rubric') })),
    workflow: (name: string, nestedArgs?: unknown) => controlled('workflow', () => wf.workflow(nonEmpty(name, 'workflow name'), jsonClone(nestedArgs, 'nested workflow args', true))),
    artifact: (name: string, value: unknown) => controlled('artifact', () => wf.artifact(nonEmpty(name, 'artifact name'), jsonClone(value, 'artifact value'))),
    log: (event: string | { readonly message: string; readonly data?: unknown }) => {
      const normalized = typeof event === 'string' ? nonEmpty(event, 'log message') : jsonClone(object(event, 'log event'), 'log event') as unknown as { readonly message: string; readonly data?: unknown }
      wf.log(normalized)
    },
  })
}

interface BridgeEnvelope {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
  readonly fatal?: boolean
}

function encodeEnvelope(value: BridgeEnvelope): string {
  return JSON.stringify(value)
}

function decodePayload(payload: string): unknown {
  try { return JSON.parse(payload) as unknown } catch (error) {
    throw new WorkflowScriptError('workflow bridge payload is not valid JSON', { cause: error, fatal: true })
  }
}

function quickJsMessage(vm: QuickJSContext, error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message
  try { return JSON.stringify(error) } catch { return String(error) }
}

const GUEST_BOOTSTRAP = String.raw`
(() => {
  "use strict";
  const parse = JSON.parse;
  const hostCall = __dshCall;
  const hostSync = __dshSync;
  try { delete globalThis.__dshCall; delete globalThis.__dshSync; } catch {}
  try {
    Object.defineProperty(globalThis, '__dshCall', { value: undefined, writable: false, configurable: false });
    Object.defineProperty(globalThis, '__dshSync', { value: undefined, writable: false, configurable: false });
  } catch {}
  const call = async (method, payload) => {
    const envelope = parse(await hostCall(method, JSON.stringify(payload === undefined ? null : payload)));
    if (!envelope.ok) {
      const error = new Error(envelope.error || ('wf.' + method + ' failed'));
      if (envelope.fatal) Object.defineProperty(error, '__workflowFatal', { value: true });
      throw error;
    }
    return envelope.value;
  };
  const sync = (method, payload) => {
    const envelope = parse(hostSync(method, JSON.stringify(payload === undefined ? null : payload)));
    if (!envelope.ok) {
      const error = new Error(envelope.error || ('wf.' + method + ' failed'));
      if (envelope.fatal) Object.defineProperty(error, '__workflowFatal', { value: true });
      throw error;
    }
    return envelope.value;
  };
  const parallel = async (thunks, options) => {
    if (!Array.isArray(thunks) || thunks.some(item => typeof item !== 'function')) throw new Error('wf.parallel expects an array of functions');
    const concurrency = options && options.concurrency !== undefined ? options.concurrency : thunks.length;
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) throw new Error('wf.parallel concurrency must be a positive integer');
    const lanes = Math.min(concurrency, __dshParallelLimit, Math.max(1, thunks.length));
    sync('parallelBegin', { concurrency: lanes });
    const result = Array(thunks.length).fill(null);
    let cursor = 0;
    const lane = async (laneIndex) => {
      for (;;) {
        const index = cursor++;
        if (index >= thunks.length) return;
        sync('parallelLaneBegin', { lane: laneIndex });
        try { result[index] = await thunks[index](); }
        catch (error) { if (error && error.__workflowFatal) throw error; result[index] = null; }
        finally { sync('parallelLaneEnd', { lane: laneIndex }); }
      }
    };
    try {
      await Promise.all(Array.from({ length: lanes }, (_, index) => lane(index)));
      return result;
    } finally {
      sync('parallelEnd', {});
    }
  };
  const pipeline = async (items, ...stages) => {
    if (!Array.isArray(items) || stages.some(stage => typeof stage !== 'function')) throw new Error('wf.pipeline expects an item array followed by functions');
    const lanes = Math.min(__dshParallelLimit, Math.max(1, items.length));
    sync('concurrentGroupBegin', { concurrency: lanes });
    const result = Array(items.length).fill(null);
    let cursor = 0;
    const lane = async (laneIndex) => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        const item = items[index];
        try {
          let value = item;
          for (const stage of stages) {
            sync('parallelLaneBegin', { lane: laneIndex });
            try { value = await stage(value, item, index); }
            finally { sync('parallelLaneEnd', { lane: laneIndex }); }
          }
          result[index] = value;
        } catch (error) { if (error && error.__workflowFatal) throw error; result[index] = null; }
      }
    };
    try {
      await Promise.all(Array.from({ length: lanes }, (_, index) => lane(index)));
      return result;
    } finally { sync('concurrentGroupEnd', {}); }
  };
  const wf = Object.freeze({
    runId: __dshRunId,
    args: __dshArgs,
    budget: Object.freeze({ total: __dshBudgetTotal, spent: () => sync('budgetSpent'), remaining: () => sync('budgetRemaining') }),
    phase: async (name, fn) => {
      if (typeof name !== 'string' || !name.trim() || typeof fn !== 'function') throw new Error('wf.phase expects a non-empty name and function');
      const token = sync('phaseBegin', { name });
      try { return await fn(); } finally { sync('phaseEnd', { token }); }
    },
    spawnAgent: input => call('spawnAgent', input),
    runAgent: input => call('runAgent', input),
    wait: (taskId, options) => call('wait', { taskId, options }),
    snapshot: taskId => call('snapshot', { taskId }),
    output: taskId => call('output', { taskId }),
    send: (taskId, content) => call('send', { taskId, content }),
    stop: (taskId, reason) => call('stop', { taskId, reason }),
    parallel,
    pipeline,
    synthesize: input => call('synthesize', input),
    workflow: (name, args) => call('workflow', { name, args }),
    artifact: (name, value) => call('artifact', { name, value }),
    log: event => { sync('log', { event }); },
  });
  Object.defineProperty(globalThis, 'wf', { value: wf, writable: false, configurable: false });
  Object.defineProperty(globalThis, 'args', { value: __dshArgs, writable: false, configurable: false });
  Math.random = () => { throw new Error('Math.random is disabled; pass deterministic entropy through args'); };
  Object.freeze(Math);
  const NativeDate = Date;
  function DeterministicDate(...values) {
    if (values.length === 0) throw new Error('Date without an explicit value is disabled; pass a timestamp through args');
    return new.target ? Reflect.construct(NativeDate, values, new.target) : NativeDate(...values);
  }
  DeterministicDate.prototype = NativeDate.prototype;
  DeterministicDate.parse = NativeDate.parse;
  DeterministicDate.UTC = NativeDate.UTC;
  DeterministicDate.now = () => { throw new Error('Date.now is disabled; pass a timestamp through args'); };
  Object.freeze(DeterministicDate);
  globalThis.Date = DeterministicDate;
  globalThis.console = Object.freeze({ log(){}, info(){}, warn(){}, error(){} });
})();
`

export async function runRestrictedWorkflowScript(options: RestrictedWorkflowRunOptions): Promise<unknown> {
  validateRestrictedWorkflowSource(options.source, options.filename)
  assertRestrictedWorkflowQuality(options.source)
  const api = proxyApi(options.wf, options.args)
  const args = jsonClone(options.args, 'workflow args', true)
  const QuickJS = await getQuickJS()
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(64 * 1024 * 1024)
  runtime.setMaxStackSize(1024 * 1024)
  let executionDeadline = Date.now() + options.syncTimeoutMs
  runtime.setInterruptHandler(() => Date.now() > executionDeadline)
  const vm = runtime.newContext()
  const pending = new Set<QuickJSDeferredPromise>()
  const hostDispatches = new Set<Promise<void>>()
  let closed = false
  let timedOut = false
  let timer: NodeJS.Timeout | undefined

  const pump = (): void => {
    if (closed || !runtime.alive) return
    executionDeadline = Date.now() + options.syncTimeoutMs
    const outcome = runtime.executePendingJobs()
    if (outcome.error !== undefined) outcome.error.dispose()
  }
  const settle = (deferred: QuickJSDeferredPromise, envelope: BridgeEnvelope): void => {
    if (closed || !deferred.alive || !vm.alive) return
    pending.delete(deferred)
    const handle = vm.newString(encodeEnvelope(envelope))
    try { deferred.resolve(handle) } finally { handle.dispose() }
    pump()
  }
  const quiesceHostDispatches = async (): Promise<void> => {
    // Closing the bridge prevents a completed dispatch from pumping guest jobs
    // that could enqueue more work. Loop defensively so every dispatch accepted
    // before closure is observed and settled before the VM is disposed.
    while (hostDispatches.size > 0) await Promise.allSettled([...hostDispatches])
  }
  const asyncDispatch = async (method: string, raw: string): Promise<unknown> => {
    const payload = decodePayload(raw)
    const record = payload === null ? {} : object(payload, `wf.${method} payload`)
    switch (method) {
      case 'spawnAgent': return await api.spawnAgent(record as unknown as WorkflowSpawnAgentInput)
      case 'runAgent': return await api.runAgent(record as unknown as WorkflowSpawnAgentInput)
      case 'wait': return await api.wait(nonEmpty(record.taskId, 'taskId'), jsonClone(record.options, 'wait options', true) as { readonly timeoutMs?: number } | undefined)
      case 'snapshot': return await api.snapshot(nonEmpty(record.taskId, 'taskId'))
      case 'output': return await api.output(nonEmpty(record.taskId, 'taskId'))
      case 'send': return await api.send(nonEmpty(record.taskId, 'taskId'), nonEmpty(record.content, 'content'))
      case 'stop': return await api.stop(nonEmpty(record.taskId, 'taskId'), nonEmpty(record.reason, 'reason'))
      case 'synthesize': return await api.synthesize(record as unknown as { readonly inputs: unknown; readonly rubric: string })
      case 'workflow': return await api.workflow(nonEmpty(record.name, 'workflow name'), jsonClone(record.args, 'nested workflow args', true))
      case 'artifact': return await api.artifact(nonEmpty(record.name, 'artifact name'), jsonClone(record.value, 'artifact value'))
      default: throw new WorkflowScriptError(`unknown workflow bridge method: ${method}`, { fatal: true })
    }
  }
  const syncDispatch = (method: string, raw: string): unknown => {
    const payload = decodePayload(raw)
    const record = payload === null ? {} : object(payload, `wf.${method} payload`)
    switch (method) {
      case 'budgetSpent': return api.budget.spent()
      case 'budgetRemaining': return api.budget.remaining()
      case 'parallelBegin': {
        const concurrency = record.concurrency
        if (!Number.isSafeInteger(concurrency) || Number(concurrency) <= 0) throw new WorkflowScriptError('parallel concurrency must be a positive integer', { fatal: true })
        options.wf[WORKFLOW_INTERNAL]?.beginParallel?.(Number(concurrency)); return null
      }
      case 'parallelEnd': options.wf[WORKFLOW_INTERNAL]?.endParallel?.(); return null
      case 'parallelLaneBegin': {
        const lane = record.lane
        if (!Number.isSafeInteger(lane) || Number(lane) < 0) throw new WorkflowScriptError('parallel lane must be a non-negative integer', { fatal: true })
        options.wf[WORKFLOW_INTERNAL]?.beginParallelLane?.(Number(lane)); return null
      }
      case 'parallelLaneEnd': {
        const lane = record.lane
        if (!Number.isSafeInteger(lane) || Number(lane) < 0) throw new WorkflowScriptError('parallel lane must be a non-negative integer', { fatal: true })
        options.wf[WORKFLOW_INTERNAL]?.endParallelLane?.(Number(lane)); return null
      }
      case 'concurrentGroupBegin': {
        const concurrency = record.concurrency
        if (!Number.isSafeInteger(concurrency) || Number(concurrency) <= 0) throw new WorkflowScriptError('concurrent group size must be a positive integer', { fatal: true })
        options.wf[WORKFLOW_INTERNAL]?.beginConcurrentGroup?.(Number(concurrency)); return null
      }
      case 'concurrentGroupEnd': options.wf[WORKFLOW_INTERNAL]?.endConcurrentGroup?.(); return null
      case 'phaseBegin': {
        const internal = options.wf[WORKFLOW_INTERNAL]
        if (internal === undefined) return 0
        return internal.beginPhase(nonEmpty(record.name, 'phase name'))
      }
      case 'phaseEnd': {
        const token = record.token
        if (!Number.isSafeInteger(token)) throw new WorkflowScriptError('phase token must be an integer', { fatal: true })
        options.wf[WORKFLOW_INTERNAL]?.endPhase(token as number)
        return null
      }
      case 'log': {
        const event = record.event
        if (typeof event === 'string') api.log(event)
        else api.log(jsonClone(object(event, 'log event'), 'log event') as unknown as { readonly message: string; readonly data?: unknown })
        return null
      }
      default: throw new WorkflowScriptError(`unknown synchronous workflow bridge method: ${method}`, { fatal: true })
    }
  }

  try {
    const asyncHandle = vm.newFunction('__dshCall', (methodHandle, payloadHandle) => {
      const deferred = vm.newPromise()
      pending.add(deferred)
      const method = vm.getString(methodHandle)
      const payload = vm.getString(payloadHandle)
      let dispatch!: Promise<void>
      dispatch = asyncDispatch(method, payload).then(
        value => settle(deferred, { ok: true, value: jsonClone(value === undefined ? null : value, `wf.${method} result`) }),
        error => settle(deferred, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          fatal: error instanceof WorkflowScriptError ? error.fatal : error instanceof Error && error.name === 'WorkflowControlError',
        }),
      ).finally(() => {
        hostDispatches.delete(dispatch)
      })
      hostDispatches.add(dispatch)
      // The dispatch is retained by hostDispatches until its finally handler, so
      // mark rejection as observed immediately; quiescence still observes the
      // original promise through allSettled before the runner exits.
      void dispatch.catch(() => {})
      return deferred.handle
    })
    const syncHandle = vm.newFunction('__dshSync', (methodHandle, payloadHandle) => {
      const method = vm.getString(methodHandle)
      try {
        const value = syncDispatch(method, vm.getString(payloadHandle))
        return vm.newString(encodeEnvelope({ ok: true, value: jsonClone(value === undefined ? null : value, `wf.${method} result`) }))
      } catch (error) {
        return vm.newString(encodeEnvelope({ ok: false, error: error instanceof Error ? error.message : String(error), fatal: error instanceof WorkflowScriptError && error.fatal }))
      }
    })
    asyncHandle.consume(handle => vm.setProp(vm.global, '__dshCall', handle))
    syncHandle.consume(handle => vm.setProp(vm.global, '__dshSync', handle))
    vm.newString(api.runId).consume(handle => vm.setProp(vm.global, '__dshRunId', handle))
    const parallelLimit = options.wf[WORKFLOW_INTERNAL]?.parallelLimit ?? Number.MAX_SAFE_INTEGER
    vm.newNumber(parallelLimit).consume(handle => vm.setProp(vm.global, '__dshParallelLimit', handle))
    vm.newString(JSON.stringify(args === undefined ? null : args)).consume(json => {
      const parsed = vm.unwrapResult(vm.evalCode(`JSON.parse(${JSON.stringify(vm.getString(json))})`))
      try { vm.setProp(vm.global, '__dshArgs', parsed) } finally { parsed.dispose() }
    })
    const total = api.budget.total
    const totalHandle = total === null ? vm.null : vm.newNumber(total)
    try { vm.setProp(vm.global, '__dshBudgetTotal', totalHandle) } finally { if (total !== null) totalHandle.dispose() }

    executionDeadline = Date.now() + options.syncTimeoutMs
    vm.unwrapResult(vm.evalCode(GUEST_BOOTSTRAP, 'dsh-workflow-bootstrap.js')).dispose()
    const wrapped = `"use strict";
${options.source}
Promise.resolve(run(wf, args)).then(value => {
  const assertJson = (item, ancestors = new Set(), depth = 0) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw new Error('workflow result contains a non-finite number'); return; }
    if (typeof item !== 'object') throw new Error('workflow result contains a non-JSON ' + typeof item + ' value');
    if (depth > 200) throw new Error('workflow result exceeds the JSON nesting limit');
    if (ancestors.has(item)) throw new Error('workflow result contains a circular reference');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const keys = Object.keys(item);
        if (keys.length !== item.length || keys.some((key, index) => key !== String(index))) throw new Error('workflow result contains a sparse array or non-index property');
        for (const child of item) assertJson(child, ancestors, depth + 1);
      } else {
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== null && Object.getPrototypeOf(prototype) !== null) throw new Error('workflow result contains a non-plain object');
        for (const key of Reflect.ownKeys(item)) {
          if (typeof key !== 'string') throw new Error('workflow result contains a symbol key');
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('workflow result contains an accessor or non-enumerable property');
          assertJson(descriptor.value, ancestors, depth + 1);
        }
      }
    } finally { ancestors.delete(item); }
  };
  const normalized = value === undefined ? null : value;
  assertJson(normalized);
  return JSON.stringify(normalized);
});`
    executionDeadline = Date.now() + options.syncTimeoutMs
    const promiseHandle = vm.unwrapResult(vm.evalCode(wrapped, options.filename ?? 'workflow.js'))
    const resolved = vm.resolvePromise(promiseHandle)
    promiseHandle.dispose()
    // Pure guest promises do not cross the host bridge, so explicitly drain the
    // initial QuickJS job queue as well as the queues drained after RPC replies.
    pump()
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        closed = true
        options.onTimeout?.()
        reject(new WorkflowScriptError(`workflow script timed out after ${options.wallTimeoutMs}ms`, { fatal: true }))
      }, options.wallTimeoutMs)
      timer.unref()
    })
    let outcome: Awaited<typeof resolved> | undefined
    let outcomeError: unknown
    try {
      outcome = await Promise.race([resolved, timeout])
    } catch (error) {
      outcomeError = error
    }
    closed = true
    try {
      // Keep the wall deadline active while draining fire-and-forget RPCs. If
      // it expires, onTimeout gets the first chance to cancel the owner work.
      await Promise.race([quiesceHostDispatches(), timeout])
    } catch (error) {
      if (timedOut || outcomeError === undefined) outcomeError = error
    }
    // Cancellation is cooperative at the WorkflowApi boundary. Even after the
    // deadline, do not tear down or return while accepted host work is alive.
    await quiesceHostDispatches()
    if (timer !== undefined) clearTimeout(timer)
    if (outcomeError !== undefined) throw outcomeError
    if (outcome === undefined) throw new WorkflowScriptError('workflow result promise did not settle', { fatal: true })
    const resultHandle = vm.unwrapResult(outcome)
    try {
      const serialized = vm.dump(resultHandle)
      if (typeof serialized !== 'string') throw new WorkflowScriptError('workflow result bridge did not return JSON', { fatal: true })
      return jsonClone(JSON.parse(serialized) as unknown, 'workflow result')
    } finally { resultHandle.dispose() }
  } catch (error) {
    if (error instanceof WorkflowScriptError) throw error
    const detail = quickJsMessage(vm, error)
    throw new WorkflowScriptError(`restricted workflow failed: ${detail}${timedOut ? ' (timed out)' : ''}`, { cause: error })
  } finally {
    closed = true
    if (timer !== undefined) clearTimeout(timer)
    for (const deferred of pending) if (deferred.alive) deferred.dispose()
    pending.clear()
    if (vm.alive) vm.dispose()
    if (runtime.alive) runtime.dispose()
  }
}
