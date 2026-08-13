# Changelog

## [Unreleased]

---

## [0.1.2] - 2026-08-13

### Fixed

- Smoke-validate command-authored inline workflows with the engine's shared child-task and deterministic admission contract before consuming the one-shot handoff grant. Invalid metadata, input schemas, read-only/agent/token limits (including concurrent reservations), provider capabilities/adapters, nested workflows, and concurrency now fail before any child starts, and the current Agent can correct the source in the same turn without falling into a disabled approval prompt.
- Publish dynamic workflow starts as session-scoped native events so a background run remains `running` after its launching tool step or turn closes; only the matching terminal `tool-workflow/run-end` decides completion, failure, or cancellation.
- State the exact `modelHint` values (`fast`, `balanced`, `deep`) in both workflow-authoring prompts.

---

## [0.1.1] - 2026-08-13

### Fixed

- Preserve the original `/workflow` query as a visible human Session message so DSH can render it, generate a session title, and identify the conversation in its Workspace.
- Keep workflow authoring instructions in separate plugin context while retaining exact one-shot approval semantics.
- Document DSH Web's manual-order five-session collapse and the “Last updated” view workaround.

---

## [0.1.0] - 2026-08-13

### Added

- Initial KodaX-parity dynamic workflow layer for DeepSeek Harness.

<!-- last-sync: f6cef1442dca3a47e1b132741b599a2d4bdbc8b8 -->
