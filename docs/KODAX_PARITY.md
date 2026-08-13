# KodaX workflow parity contract

This document is the acceptance matrix for `@dsh-external/workflow`. It records behavior, not copied implementation. KodaX is the design reference; the plugin is an independent DSH/Cordis implementation.

| Capability family | KodaX reference behavior | DSH plugin contract |
| --- | --- | --- |
| Workflow module | Metadata plus `run(wf, args)` | Same authoring model for restricted capsules and trusted-local modules |
| Capsule | Versioned JSON, source, manifest, intent, inputs, requirements, provenance | `dsh.workflow` v1 with the same information classes and DSH version provenance |
| Restricted runner | Static host-API policy, isolated capability RPC, sync/wall timeout, JSON boundary, deterministic clock/randomness | QuickJS/WASM separate heap, JSON-only host bridge, CPU/wall/memory/stack limits, deterministic guards, and bridge shutdown on timeout |
| Trusted-local runner | `.ts/.mjs/.js`, distinct trust class, confirmation | Same suffixes and explicit one-shot DSH approval before host execution |
| WorkflowApi identity | `runId`, `args`, budget view | Same |
| Agent task API | spawn, run, wait, snapshot/output, send, stop | Same, adapted to `ctx.subagents`; `runAgent` isolates ordinary terminal failure as `null`, while handle-based `wait` retains the complete result; unsupported provider features fail before launch |
| Agent request metadata | name/phase/prompt/scope/constraints/readOnly/type/target/model hint/isolation/effort/evidence/verification/schema/terse result | Same contract. Native provider/model/toolFilter/outputSchema/maxTokens fields map directly; command-authored source smoke-validates the same dispatch contract before consuming its one-shot grant; deployment dispatch and isolation adapters provide DSH-dependent target/effort/worktree seams and otherwise fail loud |
| Coordination | phase, concurrency-limited parallel, item-streaming pipeline, ordinary-failure isolation | Same |
| Synthesis | Dedicated synthesizer child | Same, routed through configurable DSH provider/model tier |
| Nesting | Named nested workflow, maximum one level | Same |
| Artifacts/logs | Named JSON artifacts and progress events | Same, durable in run graph |
| Limits | Planned/max agents, max concurrency, token budget | Same; DSH token allocation is reserved before start and reconciled from local Session usage when available |
| Read-only policy | Child write capabilities restricted | Fail-closed DSH `toolFilter` allow-list dynamically intersected with the actual parent catalog; unknown, platform-specific, and newly introduced mutation tools cannot leak through |
| Worktree isolation | Shared cwd or isolated git worktree | Shared cwd is native. Worktree requests pass only when a configured DSH-capable isolation adapter is available; otherwise preflight rejects rather than sharing cwd silently |
| Verification | Mutation/read-path/final-text postconditions, warn or hard, bounded repair | Built-in read evidence, successful mutation tool plus Git workspace fingerprint change, per-required-path before/after fingerprints, structured result, `completed_unverified`, and up to two same-actor hard repairs; versioned optional adapter adds non-Git or stronger workspace evidence |
| Structured output | Object JSON Schema, captured structured result, bounded format repair | DSH `outputSchema` capability plus exactly one same-route, tool-free repair for absent/invalid capture (including rc.2's `error`-with-report shape); a schema-invalid repair fails the task, and unsupported providers fail loud |
| Model routing | fast/balanced/deep hints and explicit target | Configured tier map keeps the DSH subagent transport distinct from the LLM provider/model route; exact subagent/provider/model overrides remain available |
| Events/process | Workflow, phase, agent, message, synthesis, artifact, terminal events and process snapshots | Stable phase/agent/step/artifact ProcessSnapshot items with counts, progress, last text and replay origin; domain events plus native `tool-workflow/*` Session records reuse the existing DSH UI. Dynamic starts are explicitly Session-scoped so a background run outlives the launching step and remains live until its terminal event |
| Run lifecycle | list/get/subscribe, pause/resume/stop | Same. Pause gates future launches; stop aborts and disposes active children |
| Durable graph | `run.json`, append-only events, artifacts, snapshots, cost report | Same classes of records under the configured DSH run directory |
| Resume/rerun | Run-id snapshot rerun, saved-name current rerun, successful result cache replay | Same distinction; only completed and verification-clean effects are cached, effective read-only policy/runtime/verification identity participates in cache keys, and replay retains the original result status with explicit replay origin |
| Retention | Delete, force stale deletion, prune preview/execute | Same with containment/path checks |
| Identity | Resolve run id, display alias, saved name; report ambiguity | Same |
| Discovery | Built-in + project/personal saved; capsule preferred; project shadows personal; trusted-local suffixes | Same priority model under `.dsh/workflows` and `$DSH_HOME/workflows` |
| Save/rename/revise | Save generated run, rename, archive-on-replace, provenance | Same, with atomic exclusive publication and canonical-root junction/symlink rejection |
| Generation | Scout-then-author, structured capsule, validation, quality lint, bounded repair and smoke execution | Same, using DSH subagents, structured output, semantic checks, three author attempts, and isolated fake-capability smoke execution |
| Preflight | Environment/tools/MCP/skills/model tiers/user interaction, approval summary | Same requirement vocabulary with DSH capability inventory config and service checks |
| Approval | Generated and trusted-local execution governed before launch | DSH `ctx.approval`, fail closed without a grant when policy requires it; a `/workflow` handoff grant is consumed only by the first inline capsule that passes pre-launch smoke validation |
| Built-ins | Parameterized parallel investigation and immutable-packet scoped review | Parallel investigation honors rubric/agent/concurrency bounds. Public packet input/writer freezes explicitly captured diff/requirements/test evidence into path-contained, budgeted, content-addressed, non-overwriting manifests and chunks. Scoped review enforces packet metadata, strict schemas/read contracts, a second high-risk primary, deterministic finding IDs, exact per-finding disposition, reason-gated severity changes, and audit artifact |
| Patterns | classify-and-act, fan-out-and-synthesize, adversarial-verification, generate-and-filter, tournament, loop-until-done | Independent templates with identical orchestration shapes |
| Human UX | `/workflow` list/create/run/runs/show/pause/resume/stop/delete/prune/rerun/save/rename/revise/help and Git review bridge | Same command surface via `ctx.commands`; free-text/create immediately hand Worker-owned scout-then-author work to the current Agent. The original query is a visible human Session message that feeds DSH title and Workspace surfaces, while authoring instructions remain separate plugin context. `/workflow review` captures default/base/commit diffs, requirements and reported test evidence into immutable packets before starting the built-in (no DSH core patch required). Starts return immediately by default; commands that support terminal waiting expose `--wait`, show defaults to latest, and stop defaults to the active run |
| Model UX | Inline `run_workflow` authoring/execution and process visibility | `run_workflow`, `workflow_list`, and `workflow_manage`, backed by the same service and immediate durable-process defaults |
| Outcome/cost | Stable workflow outcome, results, coverage/unresolved/errors, artifacts and aggregate usage | Same independent WorkflowOutcome result projection plus DSH wall time, peak concurrency, measured Session/dispatch usage, and requested/resolved route/fallback telemetry without inventing absent remote usage |

## DSH-specific compatibility rules

1. DSH remains the authority for agents, provider capabilities, tool visibility, approval, user questions, cancellation, Session events, and background job ownership.
2. A parity capability that cannot be honored by the selected DSH provider is rejected during preflight or task start. No request field is accepted and ignored.
3. Existing DSH `ctx.workflows` and the model-facing `workflow` tool remain available. This plugin is the reusable/process layer; it does not patch the agent loop or replace the native foreground script engine.
4. KodaX capsule files are not declared wire-compatible because their runtime/version provenance names KodaX. A migration command may translate data explicitly in a future version; the v0.1 line never executes a foreign capsule by accident.
5. `target`, `effort`, and worktree semantics are part of the public API. Because rc.2 has no universal host seam for them, the plugin requires an authority adapter registered before the first run; lack of that authority is a preflight error, never an ignored downgrade.
