# Configuration reference

All keys are optional. Defaults are resolved by the plugin's Schemastery config before the service starts.

| Key | Default | Purpose |
| --- | --- | --- |
| `projectDirectory` | `.dsh/workflows` | Project capsule/trusted-local catalog, relative to session cwd. |
| `personalDirectory` | `workflows` | Personal catalog, relative to `$DSH_HOME` (or `~/.dsh`). |
| `runDirectory` | `.dsh/workflow-runs` | Per-project durable run store. Absolute paths are additionally partitioned by cwd hash. |
| `listToolName` | `workflow_list` | Model-facing discovery tool name. |
| `runToolName` | `run_workflow` | Model-facing execution/authoring tool name. |
| `manageToolName` | `workflow_manage` | Model-facing lifecycle tool name. |
| `maxCapsuleBytes` | `512000` | Per workflow file admission limit. |
| `maxCatalogEntries` | `200` | Maximum catalog rows returned to callers. |
| `maxAgents` | `64` | Deployment ceiling per run. A manifest may select a lower cap. |
| `maxConcurrency` | `8` | Deployment concurrent-child ceiling shared across every project and run in this plugin instance. |
| `maxResultChars` | `50000` | Durable/rendered result-summary limit; full JSON result remains in `run.json`. |
| `scriptSyncTimeoutMs` | `10000` | VM synchronous slice limit. |
| `scriptWallTimeoutMs` | `3600000` | Whole restricted-script wall-clock limit. |
| `defaultProvider` | `spawn` | Fallback DSH subagent provider. |
| `synthesisProvider` | `spawn` | DSH subagent transport selected by `wf.synthesize`. |
| `fastProvider/ModelProvider/Model/MaxTokens` | `spawn` / unset / unset / `4096` | Fast tier: subagent transport plus optional DSH LLM provider/model route. |
| `balancedProvider/ModelProvider/Model/MaxTokens` | `spawn` / unset / unset / `8192` | Balanced/default tier: subagent transport plus optional DSH LLM provider/model route. |
| `deepProvider/ModelProvider/Model/MaxTokens` | `spawn` / unset / unset / `16384` | Deep tier: subagent transport plus optional DSH LLM provider/model route. |
| `readOnlyAllowedTools` | `read, read_image, glob, grep, lsp, skill, web_search` | Trusted read-only candidates. Each child receives only names also visible in its parent's live DSH catalog. |
| `readOnlyDeniedTools` | `[]` | Deprecated extra subtraction from the allow-list; never forwarded as an unvalidated deny-list. |
| `approvalMode` | `generated-and-local` | `never`, generated/trusted-local only, or `always`. |
| `availableTools` | `[]` | Deployment capability inventory used by capsule preflight. |
| `availableMcp` | `[]` | Available MCP server inventory used by preflight. |
| `availableSkills` | `[]` | Available skill inventory used by preflight. |
| `maxRetainedRuns` | `500` | Newest terminal runs retained automatically. Live runs are never pruned. |

Example:

```yaml
- id: dsh-external-workflow
  name: '@dsh-external/workflow'
  config:
    approvalMode: generated-and-local
    maxAgents: 32
    maxConcurrency: 6
    availableTools: [read, search]
    availableMcp: [github]
    availableSkills: [code-review]
    fastProvider: spawn
    fastModelProvider: deepseek-official
    fastModel: fast-model
    deepProvider: spawn
    deepModelProvider: deepseek-official
    deepModel: reasoning-model
```

`fastProvider`/`balancedProvider`/`deepProvider` name a provider registered on `ctx.subagents` (for example `spawn`, `fork`, `acp`). The corresponding `*ModelProvider` values name DSH LLM provider routes passed in `AgentOptions`. They are deliberately separate; a subagent transport name is never sent to the model router.

## Deployment adapters

Register these before the first workflow operation in a project context:

```ts
ctx.dynamicWorkflows.registerIsolationAdapter({
  name: 'deployment-worktree',
  async prepare({ runId, taskId, cwd, parent }) {
    // Create a contained worktree and a DSH parent Agent whose cwd points at it.
    return { cwd: isolatedCwd, parent: isolatedParent, async dispose() { /* cleanup */ } }
  },
})

ctx.dynamicWorkflows.registerVerificationAdapter({
  async preflight(cwd, policy) { /* capture an authoritative workspace baseline */ return { ok: true, reasons: [] } },
  async verify(cwd, task, result) { /* add git/diff evidence */ return { ok: true, reasons: [], changedPaths: [] } },
})

ctx.dynamicWorkflows.registerDispatchAdapter({
  async start({ target, effort, provider, request, subagents }) {
    // Route target/effort through a deployment-specific continuable-agent or model seam.
    const run = await deploymentDispatch({ target, effort, provider, request, subagents })
    return {
      run,
      telemetry: {
        provider: 'resolved-provider', model: 'resolved-model', resolvedEffort: effort,
        // Optional measured usage, fallbackReason, iterations, and durationMs belong here.
      },
    }
  },
})
```

Adapters are single registrations because isolation and verification are policy authorities. Registration after an engine has started is rejected to prevent different runs in one project from receiving different semantics.

Dispatch adapters may return a bare `SubagentRun` or `{ run, telemetry }`. The latter is the authority for final provider/model/effort, fallback and remote usage facts; the plugin never fabricates unknown remote token counts.

## Budget semantics

For a token-budgeted workflow, every possible model tier needs `maxTokens`. Before a child starts, its allocation is reserved atomically against the run budget. Local DSH children reconcile the reservation from Session usage; remote providers without local usage are conservatively charged the allocation.
