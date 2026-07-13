# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Global task defaults** can be set in `<agent-dir>/tasks-config.json` (`~/.pi/agent/tasks-config.json` by default). Project settings in `<cwd>/.pi/tasks-config.json` override global values key by key, and the settings menu persists only project-level differences.

### Changed
- **The auto-cascade setting is easier to find** in `/tasks` → Settings because its label now uses the same "auto-cascade" terminology as the documentation.

## [0.7.1] - 2026-06-24

### Changed
- **`TaskExecute` now offers a recovery path when subagents are unavailable.** When `@tintinweb/pi-subagents` isn't loaded (or its protocol version mismatches), the tool previously dead-ended with "ensure the extension is loaded". It now tells the agent it can run the work as plain Agent-tool spawns, with the explicit caveat that pi-tasks won't track those — status stays pending, cascade won't fire, and `TaskOutput` stays empty. Scoped to the unavailable branch so it doesn't conflict with the success-path guideline. Message only; no behaviour change. (#26)

## [0.7.0] - 2026-05-30

### Changed
- **⚠ Behaviour change — system-reminder delivery.** The periodic `<system-reminder>` nudge was previously appended onto the `content` of whatever unrelated tool (`read`, `bash`, `grep`, …) happened to run when it was due. That misattributed host policy text as tool output and **persisted a now-stale reminder into session history**, so it reappeared on every later turn even after task tools were used. It is now injected via the `context` hook as a **transient** `<system-reminder>`-tagged user message on the one request where it's due — not persisted, and not attached to any tool result. `tool_result` is now used solely for cadence tracking and never mutates tool output. The *cadence* (when a reminder fires) is unchanged; only the delivery mechanism and persistence differ. Cadence logic was extracted into a pure, unit-tested `src/reminder-cadence.ts`. (#19)

### Added
- **Configurable widget display settings** — four new options in `/tasks` → Settings (persisted to `.pi/tasks-config.json`), all defaulting to the previous behaviour: (#22)
  - `sortOrder` (default `id`) — `id` (creation order), `status` (completed → in-progress → pending), `recent` / `oldest` (by last-updated time). Sort logic lives in `TaskStore.list(sortOrder)`.
  - `maxVisible` (default `10`) — caps how many task lines the widget shows (`5`–`100`).
  - `showAll` (default `false`) — when `true`, every task is shown regardless of `maxVisible`.
  - `hiddenAt` (default `bottom`) — controls whether the `… and N more` overflow collapses from the `bottom` or `top` of the list; `top` pairs with `sortOrder: status` to keep active work visible.

## [0.6.1] - 2026-05-30

### Fixed
- **CI test failures on `webidl.util.markAsUncloneable is not a function`** — bumped the GitHub Actions `node-version` from `20` to `22`. Node 20's bundled `undici` lacks `webidl.util.markAsUncloneable`, which pi's event/RPC layer (exercised by `subagent-integration.test.ts`) requires. Matches the same fix in `@tintinweb/pi-subagents`.

## [0.6.0] - 2026-05-30

### Changed
- **Migrated pi peer dependencies to the `@earendil-works` scope** — `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` (`>=0.70.5`) → `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` (`>=0.74.0`). Package was renamed/rescoped across `package.json` and `src` imports; lockfile regenerated. Matches the same migration in `@tintinweb/pi-subagents`. (#21)

## [0.5.0] - 2026-04-28

### Changed
- **Bumped `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` `^0.62.0` → `^0.70.5`.** Picks up the TypeBox 1.x validator path (pi 0.69), session-replacement context invalidation (pi 0.69), the cwd-bound built-in tool removals (pi 0.68), and the working-indicator / autocomplete-provider APIs along the way. No public surface used by this extension was renamed or removed.
- **Migrated from `@sinclair/typebox` to `typebox` `^1.1.34`** per the pi 0.69 extension guidance. One-line import change in `src/index.ts`; all `Type.*` calls (`Object`, `String`, `Optional`, `Boolean`, `Number`, `Array`, `Record`, `Any`, `Unsafe`) work unchanged.
- **Toolchain bumps**: TypeScript `^5` → `^6`, `@types/node` `^20` → `^25`, `@biomejs/biome` `^2.3.5` → `^2.4.13`, `vitest` `^4.0.18` → `^4.1.5`.

## [0.4.3] - 2026-04-28

### Added
- **Cascade dependency-result injection** — when `autoCascade` is enabled, a cascaded subagent's prompt now includes a `## Prerequisite task results` section listing each completed blocker's stored `metadata.result` (capped at 4 KB per dep, with a truncation marker pointing at `TaskGet`). Cascaded agents previously had no context from their prerequisites. (#7)

### Performance
- **Spinner render rate** — reduced widget animation interval from 80 ms (12.5 fps) to 150 ms (~6.7 fps). pi-tui's `requestRender()` triggers a full component-tree re-render with no scoped invalidation, so the spinner alone could drive sustained ~70-100% single-core CPU on long sessions. ~47% fewer renders, well above the perceptual threshold where the twinkling-star animation reads as alive. (#11)

### Fixed
- **`TaskUpdate.status` schema** — replaced the `anyOf` of `enum`+`const` shape with a single flat `enum: ["pending", "in_progress", "completed", "deleted"]`. Some LLMs (notably Gemini and earlier Claude variants) parsed the previous shape into double-quoted values like `"\"completed\""`, causing `TaskUpdate` calls to silently fail validation. The accepted value set is unchanged. (#13)
- **`TaskExecute` `model` parameter now actually forwards** — the `model` option was declared on the tool and captured into the cascade config, but silently dropped at both `spawnSubagent` call sites (initial spawn and cascade). Now propagated end-to-end. (#7)

## [0.4.2] - 2026-03-24

### Added
- **Task numbers in widget** — each task line now shows its `#id` (e.g., `◻ #3 Do something`), making blocker references like `blocked by #3` easy to cross-reference at a glance. Numbers are dimmed so they stay readable without competing with the task subject.

## [0.4.1] - 2026-03-22

### Added
- **Auto-clear completed tasks** — new `autoClearCompleted` setting with three modes:
  - `never`: completed tasks stay visible until manually cleared
  - `on_list_complete` **(default)**: completed tasks are cleared after all tasks are done and a few turns pass — user sees the "all done" state before cleanup
  - `on_task_complete`: each completed task is cleared individually after a few turns
  - Both auto-clear modes use a turn-based delay (matching `REMINDER_INTERVAL`) for consistent, non-jarring UX — tasks linger briefly so the user sees the completion before they disappear
- **`AutoClearManager`** — extracted, testable class (`src/auto-clear.ts`) handling turn-based clearing logic with per-task and batch countdown tracking
- **20 new unit tests** — full coverage of all three auto-clear modes, turn delays, dependency cleanup, batch reset, dynamic mode switching, session reset, and store swap

### Changed
- **Settings** — `/tasks` → Settings now shows "Auto-clear completed tasks" toggle with `never` / `on_list_complete` / `on_task_complete` values. Also configurable via `.pi/tasks-config.json`.

### Fixed
- **`/new` and `/resume` now correctly switch session state** — `storeUpgraded` and `persistedTasksShown` flags were never reset on `session_switch`, causing the store to stay pointed at the old session file and the widget to not refresh. All session-scoped state (turn counters, reminder flags, auto-clear tracking) is now reset on both `/new` and `/resume`. Memory-mode tasks are explicitly cleared on `/new`.

## [0.4.0] - 2026-03-22

### Added
- **RPC-based subagent spawning** — `TaskExecute` now communicates with `@tintinweb/pi-subagents` via a standardized RPC envelope (`rpcCall` helper) with protocol version negotiation and timeout handling.
- **RPC-based subagent stopping** — `stopSubagent` sends stop requests via `subagents:rpc:stop` event bus RPC.
- **TaskOutput supports subagent tasks** — can wait for subagent completion with blocking/timeout, using `subagents:completed` and `subagents:failed` events.
- **TaskStop supports subagent tasks** — stops running subagents via RPC and marks the task as completed.
- **Debug logging** — set `PI_TASKS_DEBUG=1` to trace RPC communication (request/reply/timeout) and spawn errors to stderr.
- **TaskExecute prompt guidelines** — agents are instructed not to use the Agent tool for tasks already launched via TaskExecute.
- **Biome linter** — added [Biome](https://biomejs.dev/) for correctness linting.

### Changed
- **TaskOutput/TaskStop accept agent IDs** — both tools now resolve agent IDs (including partial prefixes) to task IDs via `agentTaskMap`, fixing the mismatch where TaskExecute returns agent IDs but TaskOutput/TaskStop only accepted task IDs.
- **TaskGet shows metadata** — non-empty metadata is now displayed in TaskGet output as JSON.
- **TaskGet filters completed blockers** — consistent with TaskList, TaskGet now only shows open (non-completed) blockers instead of all dependency edges.
- **TaskExecute success message** — now includes guidance to use TaskOutput for progress and not spawn duplicate agents.
- **Softened TaskExecute description** — removed "Requires @tintinweb/pi-subagents extension" from the tool description to prevent agents from refusing to use it when the extension is loaded.
- **Stopped subagents handled gracefully** — `subagents:failed` listener now distinguishes intentional stops (status `"stopped"` → mark completed, preserve partial result) from actual errors (revert to pending).

## [0.3.3] - 2026-03-17

### Added
- **Session-scoped task storage** — new `taskScope` config with three modes: `memory` (in-memory only), `session` (per-session file, default), `project` (shared across sessions). Session mode uses `tasks-<sessionId>.json`, surviving session resume while keeping sessions isolated.
- **Session resume support** — `session_switch` event handler reloads persisted tasks on resume without auto-clearing completed tasks (user may want to review).
- **Session file cleanup** — empty session task files are automatically deleted when all tasks are cleared, preventing stale file accumulation.
- **"Clear all" in `/tasks` menu** — wipe all tasks regardless of status, not just completed ones.

### Changed
- **Unified storage setting** — replaced `persistTasks` (boolean) with a single `taskScope: "memory" | "session" | "project"` setting. The `persistTasks` field is no longer recognized.
- **Auto-clear completed on new session start** — when all persisted tasks are completed, they are silently cleared instead of showing stale completed work. On resume, completed tasks are preserved.
- **Widget only shows on start if there's unfinished work** — sessions with only completed tasks start with a clean slate.
- **Settings moved to last position** in `/tasks` menu for better UX (actions first, config last).

### Fixed
- **Robust session store upgrade** — store upgrade from in-memory to file-backed triggers on `turn_start`, `before_agent_start`, `session_switch`, and `tool_execution_start` — whichever fires first.

## [0.3.2] - 2026-03-17

### Fixed
- **Completed tasks no longer vanish from the list** — completed tasks are now persisted to disk so they survive reloads and show as strikethrough instead of disappearing. Use "Clear completed" in `/tasks` to explicitly remove them.

## [0.3.1] - 2026-03-16

### Added
- **Local-by-default task persistence** — tasks now auto-persist to `<cwd>/.pi/tasks/tasks.json` on every mutation and reload on restart. No config needed. Set `PI_TASKS=off` to opt out (CI/automation).
- **Settings persistence** — `persistTasks` and `autoCascade` settings survive restarts via `<cwd>/.pi/tasks-config.json`.
- **"Persist tasks" toggle in Settings** — `/tasks` → Settings now shows two toggles: auto-execute and persist. Both are saved immediately to `tasks-config.json`.
- **Completed tasks excluded from disk** — only `pending` and `in_progress` tasks are written to disk. Completed tasks are in-memory only and pruned on restart. *(Reverted in 0.3.2 — completed tasks are now persisted.)*
- **Absolute path support** — `TaskStore` now accepts an absolute file path in addition to a short list ID.

### Changed
- **⚠ BREAKING: `PI_TASKS_FILE` / `PI_TASKS_LIST` → `PI_TASKS`** — two env vars consolidated into one. Values: `off` (in-memory), `sprint-1` (named list → `~/.pi/tasks/sprint-1.json`), `/abs/path` (absolute), `./rel/path` (relative to cwd). `PI_TASKS_LIST=name` users: rename to `PI_TASKS=name`.
- **Settings menu** — extracted to `src/ui/settings-menu.ts` and rebuilt using `ui.custom()` + `SettingsList` for native TUI rendering: keyboard navigation, live toggle, per-row descriptions, theme-consistent styling.
- **`autoCascade` setting** — now loaded from `tasks-config.json` on startup so the toggle survives restarts.
- **Hardened `TaskUpdate` description** — added "Before starting work on a task: mark it `in_progress` BEFORE beginning" as an explicit use case. Previously this rule only appeared in `TaskCreate`; now it lives in the tool actually used to set that status.
- **Removed `before_agent_start` system prompt injection** — task state is no longer injected into the system prompt on every agent loop. Analysis showed this creates wallpaper noise that trains the model to ignore the task block. Claude Code itself does not do this: the workflow contract lives in tool descriptions (read at decision time) and the periodic `<system-reminder>` nudge (fired when task tools haven't been used recently). Removed the corresponding 3 tests.
- **Widget render-once refactor** — `TaskWidget` now registers the widget callback a single time and uses `tui.requestRender()` for subsequent updates instead of calling `setWidget()` on every tick. Rendering logic extracted to `renderWidget()`. Eliminates redundant callback re-registration and keeps a cached `tui` reference for lightweight invalidation.

## [0.3.0] - 2026-03-14

### Changed
- **Eventbus RPC for subagent communication** — replaced the `Symbol.for` global registry bridge with a proper eventbus RPC protocol. [`pi-tasks`](https://github.com/tintinweb/pi-tasks) now communicates with `@tintinweb/pi-subagents` via scoped request/reply channels (`subagents:rpc:spawn`, `subagents:rpc:ping`), eliminating shared mutable global state and enabling reliable cross-extension coordination regardless of load order.
- **Presence detection** — two-path handshake: (1) ping RPC on init with scoped reply channel, (2) `subagents:ready` broadcast listener. Works whether [`pi-subagents`](https://github.com/tintinweb/pi-subagents) loads before or after [`pi-tasks`](https://github.com/tintinweb/pi-tasks).
- **Agent-task mapping** — in-memory `agentTaskMap` (agentId → taskId) replaces linear `store.list().find()` scans for O(1) completion event lookup.
- **Spawn error handling** — `spawnSubagent()` returns a Promise with 30s timeout. Failed spawns revert tasks to `pending` with error in metadata instead of silently failing.
- **Removed `SubagentBridge` type** — the `types.ts` interface for the global registry bridge is no longer needed.
- **Widget icon colors** — completed tasks show green `✔`, in-progress tasks show accent-colored `◼` (matching Claude Code's UI).

## [0.2.0] - 2026-03-12

### Added
- **`TaskExecute` tool** — execute tasks as background subagents via @tintinweb/pi-subagents. Tasks with `agentType` metadata are spawned as independent agents; validates status, dependencies, and agent type before launching.
- **`agentType` parameter on `TaskCreate`** — opt-in field (e.g., `"general-purpose"`, `"Explore"`) that marks tasks for subagent execution.
- **Auto-cascade** — when enabled via `/tasks` → Settings, completed agent tasks automatically trigger execution of their unblocked dependents, flowing through the task DAG like a build system. Off by default.
- **Subagent completion listener** — listens to `subagents:completed` and `subagents:failed` events to automatically update task status. Failed tasks revert to `pending` with error stored in metadata.
- **READY tags in system prompt** — pending tasks with `agentType` and all dependencies completed are marked `[READY — use TaskExecute to start]` in the system prompt.
- **Agent ID in widget** — in-progress tasks backed by subagents show the agent ID (e.g., `✳ Writing tests (agent abc12)…`).
- **Settings menu** — `/tasks` → Settings → toggle "Auto-execute tasks with agents".
- **`SubagentBridge` type** — typed interface for the cross-extension Symbol.for bridge.

### Changed
- `@tintinweb/pi-subagents` global registry now exposes `spawn()` and `getRecord()` in addition to `waitForAll()` and `hasRunning()`.
- `@tintinweb/pi-subagents` emits lifecycle events on `pi.events`: `subagents:created`, `subagents:started`, `subagents:completed`, `subagents:failed`, `subagents:steered`.
- `AgentManager` accepts an optional `onStart` callback, fired when an agent transitions to running (including from queue).

## [0.1.0] - 2026-03-12

Initial release — Claude Code-style task tracking and coordination for pi.

### Added
- **6 LLM-callable tools** — `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskOutput`, `TaskStop` — matching Claude Code's exact tool specs, descriptions, and schemas.
- **System-reminder injection** — periodic `<system-reminder>` nudges appended to non-task tool results when tasks exist but task tools haven't been used for 4+ turns. Matches Claude Code's host-level reminder mechanism.
- **Prompt guidelines** — `promptGuidelines` on TaskCreate injects persistent guidance into the system prompt, nudging the LLM to use task tools for complex work.
- **Task state in system prompt** — `before_agent_start` event appends current task state to the system prompt on every agent loop, ensuring task awareness survives context compaction.
- **Persistent widget** — live task list above editor with `✔` (completed, strikethrough + dim), `◼` (in-progress), `◻` (pending), animated star spinner (`✳✽`) for active tasks with elapsed time and token counts (e.g., `✳ Running tests… (2m 49s · ↑ 4.1k ↓ 1.2k)`).
- **Multiple parallel active tasks** — widget supports multiple simultaneous spinners.
- **`/tasks` command** — interactive menu: view tasks with actions (start, complete, delete), create tasks, clear completed.
- **Bidirectional dependency management** — `addBlocks`/`addBlockedBy` maintain both sides automatically. Edges cleaned up on task deletion.
- **Dependency warnings** — cycles, self-dependencies, and dangling references produce warnings in TaskUpdate responses. Edges are still stored, matching Claude Code's permissive behavior.
- **File-backed shared storage** — set `PI_TASK_LIST_ID` env var for multi-session coordination at `~/.pi/tasks/<id>.json`. File locking with stale-lock detection prevents race conditions.
- **In-memory session-scoped mode** — default when no env var is set, zero disk I/O.
- **Background process tracker** — output buffering (stdout + stderr), waiter notification, graceful stop with timeout escalation (SIGTERM → 5s → SIGKILL).
- **78 unit tests** — task store CRUD, dependencies, warnings, file persistence; widget rendering, icons, spinners, token/duration formatting; process tracker lifecycle.

[0.7.1]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.7.1
[0.7.0]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.7.0
[0.6.1]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.6.1
[0.6.0]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.6.0
[0.5.0]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.5.0
[0.4.3]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.4.3
[0.4.2]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.4.2
[0.4.1]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.4.1
[0.4.0]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.4.0
[0.3.3]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.3.3
[0.3.2]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.3.2
[0.3.1]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.3.1
[0.3.0]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.3.0
[0.2.0]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.2.0
[0.1.0]: https://github.com/tintinweb/pi-tasks/releases/tag/v0.1.0
