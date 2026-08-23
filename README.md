# @tintinweb/pi-tasks

A [pi](https://pi.dev) extension that brings **Claude Code-style task tracking and coordination** to pi. Track multi-step work with structured tasks, dependency management, and a persistent visual widget.

> **Status:** Early release.

<img width="600" alt="pi-tasks screenshot" src="https://github.com/tintinweb/pi-tasks/raw/master/media/screenshot.png" />

https://github.com/user-attachments/assets/1d0ee87a-e0a5-4bfa-a9b9-2f9144cb905b



## Features

- **7 LLM-callable tools** — `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskOutput`, `TaskStop`, `TaskExecute` — matching Claude Code's exact tool specs and descriptions
- **Persistent widget** — live task list above the editor with `✔`/`◼`/`◻` status marks, task numbers (`#1`, `#2`, …), strikethrough for completed tasks, star spinner (`✳✽`) for active tasks with elapsed time and token counts. Every glyph is [configurable](CUSTOMIZING.md#task-glyphs)
- **System-reminder injection** — periodic `<system-reminder>` nudges injected into the upcoming LLM request (via the `context` hook, transient and never persisted) when task tools haven't been used recently, or when a task is left stuck `in_progress` after a text-only turn. Shaped after Claude Code's todo reminders — an empty-list nudge or a JSON echo of the current list (capped at 10 tasks)
- **Prompt guidelines** — workflow contract encoded in tool descriptions, nudging the LLM at the point of tool use
- **Dependency management** — bidirectional `blocks`/`blockedBy` relationships with warnings for cycles, self-deps, and dangling references
- **Shared task lists** — multiple pi sessions can share a file-backed task list for agent team coordination
- **File locking** — concurrent access is safe when multiple sessions share a task list
- **Background process tracking** — track spawned processes with output buffering, blocking wait, and graceful stop
- **Subagent integration** — tasks with `agentType` can be executed as subagents via `TaskExecute` (requires [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)). Auto-cascade mode flows through the task DAG automatically when enabled.

## Install

```bash
pi install npm:@tintinweb/pi-tasks
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

## Widget

The extension renders a persistent widget above the editor:

```
● 4 tasks (1 done, 1 in progress, 2 open)
  ✔ #1 Design the flux capacitor
  ✳ #2 Acquiring plutonium… (2m 49s · ↑ 4.1k ↓ 1.2k)
  ◻ #3 Install flux capacitor in DeLorean › blocked by #1
  ◻ #4 Test time travel at 88 mph › blocked by #2, #3
```

| Glyph | Meaning |
|------|---------|
| `✔` | Completed (strikethrough + dim) |
| `◼` | In-progress (not actively executing) |
| `◻` | Pending |
| `✳`/`✽` | Animated star spinner — actively executing task (shows `activeForm` text, elapsed time, token counts) |

### Widget display settings

How tasks are sorted and how many are shown can be configured via `/tasks` → Settings (saved as project overrides in `.pi/tasks-config.json`), except `glyphs`, which is set in the config file directly. All defaults preserve the original behaviour.

> **[→ Customizing the task widget](CUSTOMIZING.md)** — the full guide: global vs. project config, sort presets, writing your own sort order, and recipes.

| Setting | Values | Default | Behaviour |
|---------|--------|---------|-----------|
| `sortOrder` | `id` / `status` / `active` / `recent` / `oldest`, or a [sort spec](CUSTOMIZING.md#writing-your-own-sort-order) | `id` | `id` = creation order; `status` groups completed → in-progress → pending; `active` is the reverse grouping (in-progress → pending → completed); `recent`/`oldest` = by last-updated time |
| `collapseCompleted` | `true` / `false` | `false` | When `true`, completed tasks are replaced by a single `✔ N completed` line at the bottom |
| `maxVisible` | `5`–`100` | `10` | Caps how many task lines the widget shows (ignored when `showAll` is on) |
| `showAll` | `true` / `false` | `false` | When `true`, every listed task is shown regardless of `maxVisible` |
| `hiddenAt` | `bottom` / `top` | `bottom` | When the list overflows `maxVisible`, where the `… and N more` collapse happens. `top` pairs well with `sortOrder: status` to keep active work visible and fold completed tasks away |
| `glyphs` | a [glyph set](CUSTOMIZING.md#task-glyphs) | `✔` / `◼` / `◻` + star spinner | Every character the widget is drawn with — status marks, spinner frames, header bullet, overflow and truncation markers, token arrows. Config file only |

> Note: the widget's `status` order is completed-first (so finished work collapses at the top with `hiddenAt: top`), which is the reverse of the `TaskList` tool's pending-first order. Use `active` for pending-first.

`collapseCompleted` and the visible limit are independent: collapsing decides what goes in the list, and `maxVisible` / `showAll` / `hiddenAt` then apply to whatever remains.

For an order the presets don't cover, `sortOrder` also accepts a **sort spec** — an ordered list of comparison keys, written into `tasks-config.json`:

```json
{
  "sortOrder": [
    { "field": "status", "rank": ["in_progress", "pending", "completed"] },
    { "field": "id" }
  ]
}
```

See [Writing your own sort order](CUSTOMIZING.md#writing-your-own-sort-order) for the full key reference and recipes.

> Configuration is data, never code. There is deliberately no executable config file, so nothing in a cloned repository's `.pi/` can run on your machine.

## Tools

### `TaskCreate`

Create a structured task. Used proactively for complex multi-step work.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subject` | string | yes | Brief imperative title |
| `description` | string | yes | Detailed context and acceptance criteria |
| `activeForm` | string | no | Present continuous form for spinner (e.g., "Running tests") |
| `agentType` | string | no | Agent type for subagent execution (e.g., `"general-purpose"`, `"Explore"`) |
| `metadata` | object | no | Arbitrary key-value pairs |

```
→ Task #1 created successfully: Fix authentication bug
```

### `TaskList`

List all tasks with status, owner, and blocked-by info.

```
#1 [pending] Fix authentication bug
#2 [in_progress] Write unit tests (agent-1)
#3 [pending] Update docs [blocked by #1, #2]
```

Sort order: pending first, then in-progress, then completed (each group by ID).

### `TaskGet`

Get full details for a specific task.

```
Task #2: Write unit tests
Status: in_progress
Owner: agent-1
Description: Add tests for the auth module
Blocked by: #1
Blocks: #3
```

Shows owner (if set) and open (non-completed) dependency edges. Non-empty metadata is displayed as JSON.

### `TaskUpdate`

Update task fields, status, metadata, and dependencies.

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskId` | string | Task ID (required) |
| `status` | `pending` / `in_progress` / `completed` / `deleted` | New status |
| `subject` | string | New title |
| `description` | string | New description |
| `activeForm` | string | Spinner text |
| `owner` | string | Agent name |
| `metadata` | object | Shallow merge (null values delete keys) |
| `addBlocks` | string[] | Task IDs this task blocks |
| `addBlockedBy` | string[] | Task IDs that block this task |

```
→ Updated task #1 status
→ Updated task #2 owner, status
→ Updated task #3 blocks
→ Updated task #3 blocks (warning: cycle: #3 and #1 block each other)
→ Updated task #1 deleted
```

Setting `status: "deleted"` permanently removes the task.

Dependencies are bidirectional: `addBlocks: ["3"]` on task 1 also adds `blockedBy: ["1"]` to task 3.

### `TaskOutput`

Retrieve output from a background task process.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task_id` | string | — | Task ID or agent ID (required) |
| `block` | boolean | `true` | Wait for completion |
| `timeout` | number | `30000` | Max wait time in ms (max 600000) |

Both task IDs and agent IDs (including partial prefixes) are accepted — agent IDs are resolved via the internal `agentTaskMap`.

### `TaskStop`

Stop a running background task process. Sends SIGTERM, waits 5 seconds, then SIGKILL. For subagent tasks, sends a stop RPC.

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_id` | string | Task ID or agent ID to stop |

### `TaskExecute`

Execute one or more tasks as background subagents. Requires [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents).

| Parameter | Type | Description |
|-----------|------|-------------|
| `task_ids` | string[] | Task IDs to execute (required) |
| `additional_context` | string | Extra context appended to each agent's prompt |
| `model` | string | Model override (e.g., `"sonnet"`, `"haiku"`) |
| `max_turns` | number | Max turns per agent |

Tasks must be `pending`, have `agentType` set, and all `blockedBy` dependencies `completed`. Each task spawns as an independent background subagent.

With **auto-cascade** enabled (via `/tasks` → Settings), completed tasks automatically trigger execution of their unblocked dependents — flowing through the DAG like a build system. Each cascaded agent receives its prerequisites' stored results in the prompt, so it can build directly on what came before without re-fetching.

## Task Lifecycle

```
pending → in_progress → completed
                      → deleted (permanently removed)
```

Tasks are created as `pending`. Mark `in_progress` before starting work, `completed` when done. `deleted` removes entirely — IDs never reset.

## Dependency Management

- **Bidirectional edges:** `addBlocks`/`addBlockedBy` maintain both sides automatically
- **Dependency warnings:** cycles, self-dependencies, and references to non-existent tasks are stored but produce warnings in the tool response
- **Display-time filtering:** `TaskList` only shows non-completed blockers in `[blocked by ...]`
- **Raw data preserved:** `TaskGet` shows ALL edges, including completed blockers
- **Cleanup on deletion:** removing a task cleans up all edges pointing to it

## Task Storage

Task storage is controlled by the `taskScope` setting (`/tasks` → Settings → Task storage):

| Mode | File | Behaviour |
|------|------|-----------|
| `memory` | *(none)* | In-memory only — tasks lost when session ends |
| `session` **(default)** | `<workspace>/.pi/tasks/tasks-<sessionId>.json` | Per-session file — isolated between sessions, survives resume |
| `session-global` | `<agent-dir>/tasks/sessions/<project-key>/tasks-<sessionId>.json` | The same, kept outside the workspace so repositories stay clean |
| `project` | `<workspace>/.pi/tasks/tasks.json` | Shared across all sessions in the project |

`<workspace>` is the directory pi reports for the session — the same one its file tools operate in. That is normally where you started pi; it differs only when a session is opened by an explicit path from another project, or when a host serves sessions from elsewhere.

`session-global` exists because a per-session file keyed by a session ID is runtime state, not project content: it means nothing to anyone else who clones the repository, and it costs a `.gitignore` rule per project. `<agent-dir>` is `~/.pi/agent` unless pi is configured otherwise, the same directory the [global settings](#global-defaults) live in. `<project-key>` encodes the workspace path the way pi encodes it for its own session logs (`/Users/me/work/repo` → `--Users-me-work-repo--`), so a project's task files sit under the same name as its transcripts and same-ID sessions in different workspaces cannot collide.

Under either session scope, tasks stay in memory whenever pi is not persisting the session (`pi --no-session`) — there is no session for the file to belong to, so none is written. `project` scope still writes its shared list, since that belongs to the project rather than the session.

Switching to `session-global` never moves or deletes anything. It changes where *new* session files are created; a session that already has a file in `<workspace>/.pi/tasks/` keeps using it, so resuming that session still finds its tasks and switching back to `session` strands nothing. To empty an existing `.pi/tasks/`, clear those sessions' tasks as usual — the file is removed once its list is empty.

Picking `session-global` from `/tasks` → Settings saves it as a *project* override in `<workspace>/.pi/tasks-config.json`, so that repository still gets a `.pi/` — holding config rather than task data. To apply it everywhere and leave repositories alone, set it once as a [global default](#global-defaults) instead:

```json
{
  "taskScope": "session-global"
}
```

On new session start, if all persisted tasks are completed they are auto-cleared for a clean slate. On session resume, all tasks (including completed) are shown so the user can review progress. Empty session files are automatically deleted when all tasks are cleared.

### Auto-clear completed tasks

The `autoClearCompleted` setting controls automatic cleanup of completed tasks:

| Mode | Behaviour |
|------|-----------|
| `never` | Completed tasks stay visible until manually cleared via `/tasks` → Clear completed |
| `on_list_complete` **(default)** | Cleared once all tasks are done and a few idle turns pass |
| `on_task_complete` | Each completed task cleared individually after a few turns |

Both auto-clear modes use a turn-based delay for non-jarring UX — tasks linger briefly so you see the completion before they disappear.

In either mode, a list with nothing left to do is also retired when a *later* batch of work begins, however long it has been sitting there. The turn delay only runs while the conversation does, so a list completed just before the agent stopped would otherwise still be on screen when the next task arrived, and that task would join it. The finished list stays visible while you read it and through any follow-up question, and goes when the agent starts new work. Tasks the agent adds to a list it is still working through are unaffected, and task IDs stay monotonic and are never reused.

Settings (`taskScope`, `autoCascade`, `autoClearCompleted`, plus the [widget display settings](#widget-display-settings) `sortOrder` / `collapseCompleted` / `maxVisible` / `showAll` / `hiddenAt`) changed through `/tasks` are saved as project overrides in `<workspace>/.pi/tasks-config.json`. `glyphs` is config-file only — see [CUSTOMIZING.md](CUSTOMIZING.md#task-glyphs).

### Global defaults

Put settings that should apply across projects in `<agent-dir>/tasks-config.json` (`~/.pi/agent/tasks-config.json` by default). The agent directory follows pi's configured agent path. Project settings in `<workspace>/.pi/tasks-config.json` take precedence key by key.

For example, enable auto-cascade by default for every project:

```json
{
  "autoCascade": true
}
```

The `/tasks` settings menu writes only project overrides. Changing another setting in a project does not copy global defaults into that project's config.

See [Customizing the task widget](CUSTOMIZING.md#where-config-lives) for worked examples of how the two files merge.

### Override via environment variables

| Variable | Value | Behaviour |
|----------|-------|-----------|
| `PI_TASKS` | `off` | In-memory only (CI/automation) |
| `PI_TASKS` | `sprint-1` | Named shared list at `~/.pi/tasks/sprint-1.json` |
| `PI_TASKS` | `/abs/path/tasks.json` | Explicit absolute file path |
| `PI_TASKS` | `./tasks.json` | Relative path resolved from the session workspace |
| *(unset)* | | Uses `taskScope` setting (default: `session`) |
| `PI_TASKS_DEBUG` | `1` | Trace RPC communication (request/reply/timeout) and spawn errors to stderr |

Named and explicit paths use a file-locked store with stale-lock detection — safe for multiple pi sessions coordinating on the same task list.

**CI example** (`.envrc`):
```bash
export PI_TASKS=off
```

**Shared team list** (`.envrc`):
```bash
export PI_TASKS=my-project
```

## `/tasks` Command

Interactive menu:

```
Tasks
├─ View all tasks (4)
├─ Create task
├─ Clear completed (1)
├─ Clear all (4)
└─ Settings
```

- **View all tasks** — select a task to see details and take actions (start, complete, delete)
- **Create task** — input prompts for subject and description
- **Clear completed** — remove all completed tasks
- **Clear all** — remove all tasks regardless of status
- **Settings** — configure project overrides for task storage, auto-cascade, auto-clear completed tasks, and [widget display](#widget-display-settings) (sort order, max visible, show all, hidden position)

## Cross-extension Communication with [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)

[`pi-tasks`](https://github.com/tintinweb/pi-tasks) communicates with [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) via pi's eventbus using a scoped request/reply RPC protocol. No shared global state — just events.

### Presence Detection

Load order doesn't matter. Two handshake paths ensure detection regardless of which extension loads first:

1. **Ping on init** — [`pi-tasks`](https://github.com/tintinweb/pi-tasks) emits `subagents:rpc:ping` with a unique `requestId` and listens for `subagents:rpc:ping:reply:{requestId}`. If [`pi-subagents`](https://github.com/tintinweb/pi-subagents) is already loaded, it replies immediately.
2. **Ready broadcast** — [`pi-subagents`](https://github.com/tintinweb/pi-subagents) emits `subagents:ready` when it initializes. If [`pi-tasks`](https://github.com/tintinweb/pi-tasks) loaded first, it picks this up.

```
┌─────────────┐                    ┌──────────────────┐
│  pi-tasks   │                    │  pi-subagents    │
└──────┬──────┘                    └────────┬─────────┘
       │                                    │
       │──── subagents:rpc:ping ───────────▶│
       │◀─── subagents:rpc:ping:reply ──────│
       │                                    │
       │◀─── subagents:ready ───────────────│  (broadcast on init)
       │                                    │
```

### Spawning Subagents

When `TaskExecute` runs, it sends a spawn RPC with a scoped reply channel:

```
pi-tasks                                pi-subagents
   │                                         │
   │── subagents:rpc:spawn ─────────────────▶│  { requestId, type, prompt, options }
   │◀─ subagents:rpc:spawn:reply:{reqId} ───│  { id }  (or { error })
   │                                         │
```

The returned `id` is stored in an in-memory `agentTaskMap` (agentId → taskId) for O(1) completion lookup. A 30-second timeout rejects the Promise if no reply arrives.

### Lifecycle Events

[`pi-subagents`](https://github.com/tintinweb/pi-subagents) emits lifecycle events that [`pi-tasks`](https://github.com/tintinweb/pi-tasks) listens to:

| Event | Payload | Action |
|-------|---------|--------|
| `subagents:completed` | `{ id, result? }` | Mark task `completed`, trigger auto-cascade if enabled |
| `subagents:failed` | `{ id, error?, status }` | Revert task to `pending`, store error in metadata |

### Standalone Mode

If [`pi-subagents`](https://github.com/tintinweb/pi-subagents) is not installed, everything works except `TaskExecute`, which returns a friendly message explaining the agent can fall back to plain Agent-tool spawns — with the caveat that pi-tasks won't track those (status stays `pending`, auto-cascade won't fire, `TaskOutput` stays empty). All core task tools (create, list, get, update, dependencies, widget, system-reminder injection) function independently.

## Architecture

```
src/
├── index.ts            # Extension entry: 7 tools + /tasks command + widget + subagent integration
├── types.ts            # Task, TaskStatus, BackgroundProcess types
├── task-store.ts       # File-backed store with CRUD, dependencies, locking
├── auto-clear.ts       # Turn-based auto-clearing of completed tasks (AutoClearManager)
├── tasks-config.ts     # Global defaults and project override persistence
├── task-glyphs.ts      # Glyph defaults and config validation
├── process-tracker.ts  # Background process output buffering and stop
└── ui/
    ├── task-widget.ts  # Persistent widget with status glyphs and spinner
    └── settings-menu.ts  # /tasks → Settings panel (SettingsList TUI component)
```

## Future Work

- **Background Bash auto-task creation** — Claude Code auto-creates tasks when `Bash` runs with `run_in_background: true`. Pi's bash tool currently lacks a `run_in_background` parameter (only `command` + `timeout`), so there's nothing to hook into. Once pi adds background execution support to its bash tool, we can use the `tool_call` event to detect it and auto-create tasks via `TaskStore`/`ProcessTracker`.

## Development

```bash
npm install
npm run typecheck   # TypeScript validation
npm test            # Run unit tests
```

## License

MIT — [tintinweb](https://github.com/tintinweb)
