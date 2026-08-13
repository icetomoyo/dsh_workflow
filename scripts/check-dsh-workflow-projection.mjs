import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const snapshot = resolve(process.env.DSH_SNAPSHOT_DIR ?? '../test-icetomoyo')
const runtimePath = resolve(snapshot, 'packages/client/runtime/lib/types/client/index.js')
const workflowPath = resolve(snapshot, 'packages/client/ui-workflow-run/lib/types/client/workflow-definition.js')
for (const path of [runtimePath, workflowPath]) {
  if (!existsSync(path)) throw new Error(`DSH client build output is missing: ${path}`)
}

const [{ ConversationNodeAssembler }, { workflowRunDefinition }] = await Promise.all([
  import(pathToFileURL(runtimePath).href),
  import(pathToFileURL(workflowPath).href),
])

class EventDefinitions {
  entries() { return [workflowRunDefinition] }
  fallbackEntry() { return undefined }
}

const chatView = {
  target: 'chat',
  create: () => {
    let nodes = new Map()
    const snapshot = () => ({ nodes })
    return {
      empty: snapshot(),
      replace: ({ nodes: values }) => { nodes = new Map(values.map(node => [node.key, node])); return snapshot() },
      apply: ({ upserts }) => { nodes = new Map(nodes); for (const node of upserts) nodes.set(node.key, node); return snapshot() },
    }
  },
}

class ViewDefinitions {
  entries() { return [chatView] }
}

const input = (seq, type, data) => ({ event: { seq, time: seq * 100, type, data }, view: undefined })
const assembler = new ConversationNodeAssembler(new EventDefinitions(), new ViewDefinitions())
assembler.replaceWindow([
  input(1, 'turn/start', { turn: 1 }),
  input(2, 'step/start', { turn: 1, step: 1 }),
  input(3, 'tool-workflow/run-start', { runId: 'background', name: 'background', turn: null }),
  input(4, 'tool-workflow/agent-start', { runId: 'background', seq: 1, label: 'worker', childId: 'child-1' }),
  input(5, 'step/end', { turn: 1, step: 1 }),
  input(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
], false)
assembler.flush()

const data = () => [...assembler.snapshot('chat').nodes.values()][0]?.data
if (data()?.status !== 'running' || data()?.phases[0]?.members[0]?.status !== 'running') {
  throw new Error(`DSH projected a session-scoped background workflow incorrectly: ${JSON.stringify(data())}`)
}
assembler.append(input(7, 'tool-workflow/agent-end', { runId: 'background', seq: 1, outcome: 'completed' }))
assembler.append(input(8, 'tool-workflow/run-end', { runId: 'background', stopReason: 'completed' }))
assembler.flush()
if (data()?.status !== 'completed' || data()?.phases[0]?.members[0]?.status !== 'completed') {
  throw new Error(`DSH ignored the workflow terminal facts: ${JSON.stringify(data())}`)
}

console.log('DSH session-scoped workflow projection verified')
