# Security model

## Trust classes

| Class | Source | Authority |
| --- | --- | --- |
| `trusted-package` | Plugin built-ins/patterns | Shipped code, executed through the same restricted runtime when source-based. |
| `capability-generated` | `.workflow.json`, authored inline, run snapshot | No direct host access; effects only through WorkflowApi. |
| `trusted-local` | Project/personal `.ts/.mjs/.js` | Full Node host authority; explicit one-shot confirmation before import. |

## Restricted runner controls

- Strict source contract and compile check.
- Static rejection of imports, require, process, filesystem, child processes/shell, network, alternate runtimes, timers, dynamic globals, `eval`/`Function`, prototype-constructor access, and `__proto__`.
- A separate QuickJS WebAssembly heap: no Node object, prototype, `Function` constructor, module loader, or host Promise is injected.
- Frozen guest API plus deterministic `Math`/`Date` guards.
- Synchronous CPU slices, wall-clock timeout, memory, and stack limits. Wall timeout closes the bridge, aborts the owner run, and waits for child disposal.
- JSON clone on arguments, capability inputs/outputs and final result.
- Agent, concurrency and token limits enforced by the host.

Capability-generated code is isolated from Node authority by QuickJS/WASM and can affect the host only through validated WorkflowApi calls. Accepted host calls are tracked to quiescence: returning from `run()` does not detach fire-and-forget effects, and timeout closes the bridge before cancellation/drain. It is still an in-process component rather than an OS container. Never grant an unreviewed workflow write-capable child tools, and never load untrusted code as `trusted-local`.

## DSH authority

Child execution remains governed by the selected DSH provider. Read-only tasks require provider `toolFilter` support. Structured output requires provider `outputSchema` support. Missing capabilities reject before child launch. Normal DSH tool approvals and sandbox policies continue to apply inside children.

## Filesystem safety

- Workflow names use a strict kebab-case identifier.
- Catalog files must be ordinary files, not symlinks.
- All save/rename/delete/artifact paths are resolved below their configured roots.
- Capsule size and catalog count are bounded.
- Writes use a same-directory temporary file followed by atomic rename.
- Replacement writes complete first, then use a rollback-safe archive swap; failed swaps restore the old active capsule and clean the temporary file.
- Active runs cannot be deleted, including with force; force is reserved for non-terminal stale records after restart.

## Reporting a vulnerability

Open a private security report with the repository owner. Do not include tokens, proprietary workflow contents, full Session logs, or filesystem paths that reveal secrets in a public issue.
