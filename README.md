# @tintinweb/pi-tasks

A [pi](https://pi.dev) extension that brings **Claude Code-style task tracking and coordination** to pi. Track multi-step work with structured tasks, dependency management, and a persistent visual widget.

> **Status:** Early release.

<img width="600" alt="pi-tasks screenshot" src="https://github.com/tintinweb/pi-tasks/raw/master/media/screenshot.png" />

https://github.com/user-attachments/assets/1d0ee87a-e0a5-4bfa-a9b9-2f9144cb905b



## Features

- **7 LLM-callable tools** — `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskOutput`, `TaskStop`, `TaskExecute` — for task creation, updates, execution, and inspection
- **Persistent widget** — live task list above the editor with `✔`/`◼`/`◻` status icons, task numbers (`#1`, `#2`, …), strikethrough for completed tasks, star spinner (`✳✽`) for active tasks with elapsed time and token counts
- **System-reminder injection** — periodic `<system-reminder>` nudges appended to tool results when task tools haven't been used recently (matches Claude Code's behavior exactly)
- **Prompt guidelines** — workflow contract encoded in tool descriptions, nudging the LLM at the point of tool use
- **Dependency and relationship management** — hard `blocks`/`blockedBy` dependencies plus non-blocking relationships such as `parent`, `related`, `validates`, `supersedes`, and `orderAfter`
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

| Icon | Meaning |
|------|---------|
| `✔` | Completed (strikethrough + dim) |
| `◼` | In-progress (not actively executing) |
| `◻` | Pending |
| `✳`/`✽` | Animated star spinner — actively executing task (shows `activeForm` text, elapsed time, token counts) |

## Tools

### `TaskCreate`

Create one or more structured tasks. Pass `tasks`, an array of task objects; use one element for a single task.

| Task field | Type | Required | Description |
|------------|------|----------|-------------|
| `key` | string | no | Temporary key for references inside this create call |
| `subject` | string | yes | Brief imperative title |
| `description` | string | yes | Detailed context and acceptance criteria |
| `activeForm` | string | no | Present continuous form for spinner (e.g., "Running tests") |
| `agentType` | string | no | Agent type for subagent execution (e.g., `"general-purpose"`, `"Explore"`) |
| `metadata` | object | no | Arbitrary key-value pairs |
| `blocks` | string[] | no | Task IDs or keys this task blocks |
| `blockedBy` | string[] | no | Task IDs or keys that block this task |
| `relations` | object[] | no | Non-blocking relationships with `type` and `target` |

```json
{
  "tasks": [
    { "key": "design", "subject": "Design API", "description": "Decide the shape" },
    {
      "key": "docs",
      "subject": "Document API",
      "description": "Write usage notes",
      "blockedBy": ["design"],
      "relations": [{ "type": "validates", "target": "design" }]
    }
  ]
}
```

```
→ Created 2 tasks:
#1 Design API
#2 Document API
```

### `TaskList`

List all tasks with status, owner, blocked-by info, and hierarchy summaries.

```
#1 [pending] Deliver feature [container 1/3 done] [parallel #3, #4]
  ↳ #2 [completed] Design API
  ↳ #3 [pending] Implement API
  ↳ #4 [pending] Write docs
#5 [pending] Validate feature [blocked by #3, #4]
```

Flat lists sort pending first, then in-progress, then completed (each group by ID). Hierarchical lists render parent tasks with indented subtasks so container context stays visible.

### `TaskGet`

Get full details for a specific task.

```
Task #2: Write unit tests
Status: in_progress
Owner: agent-1
Description: Add tests for the auth module
Parent: #1
Parallel siblings: #4
Blocked by: #1
Blocks: #3
Relations: parent #1, validates #1
```

For parent tasks, `TaskGet` also shows direct subtasks, aggregate subtask progress, available parallel subtasks, and ready-to-complete hints. Shows owner (if set), open dependency edges, and non-blocking relationships. Non-empty metadata is displayed as JSON.

### `TaskUpdate`

Update one or more tasks. Pass `updates`, an array of update objects; use one element for a single task.

| Update field | Type | Description |
|--------------|------|-------------|
| `taskId` | string | Task ID (required) |
| `status` | `pending` / `in_progress` / `completed` / `deleted` | New status |
| `subject` | string | New title |
| `description` | string | New description |
| `activeForm` | string | Spinner text |
| `owner` | string | Agent name |
| `metadata` | object | Shallow merge (null values delete keys) |
| `addBlocks` | string[] | Hard dependencies this task blocks |
| `addBlockedBy` | string[] | Hard dependencies that block this task |
| `setRelations` | object[] | Replace non-blocking relationships |
| `addRelations` | object[] | Add non-blocking relationships |
| `removeRelations` | object[] | Remove matching non-blocking relationships |

```json
{
  "updates": [
    { "taskId": "1", "status": "completed" },
    { "taskId": "2", "status": "deleted" }
  ]
}
```

```
→ Updated task #1 status
→ Updated task #2 deleted
```

Setting `status: "deleted"` permanently removes the task.

Dependencies are bidirectional: `addBlocks: ["3"]` on task 1 also adds `blockedBy: ["1"]` to task 3. Non-blocking `relations` are directional structure only and do not affect whether a task can start.

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

## Dependency, Hierarchy, and Relationship Management

- **Batch creation:** `TaskCreate` can create tasks and resolve temporary `key` references in one atomic mutation
- **Bidirectional hard edges:** `blocks`/`blockedBy` and `addBlocks`/`addBlockedBy` maintain both sides automatically
- **Hierarchy:** `relations: [{ "type": "parent", "target": "..." }]` nests a subtask under a parent/container task
- **Parallel subtasks:** Siblings under the same parent with no hard dependency edge between them are shown as parallel-capable; multiple currently unblocked children are shown as `parallel #...`
- **Non-blocking relations:** `relations`, `setRelations`, `addRelations`, and `removeRelations` record structure without blocking execution
- **Completion hints:** Parent tasks show aggregate subtask progress and are reported as ready to complete once all subtasks are completed
- **Dependency warnings:** cycles, self-dependencies, and references to non-existent tasks are stored but produce warnings in the tool response
- **Display-time filtering:** `TaskList` only shows non-completed blockers in `[blocked by ...]`
- **Raw data preserved:** `TaskGet` shows all hard edges and non-blocking relations
- **Cleanup on deletion:** removing a task cleans up hard edges and relations pointing to it

Example nested task set:

```json
{
  "tasks": [
    { "key": "feature", "subject": "Deliver feature", "description": "Container task" },
    {
      "key": "api",
      "subject": "Implement API",
      "description": "Build the endpoint",
      "relations": [{ "type": "parent", "target": "feature" }]
    },
    {
      "key": "docs",
      "subject": "Write docs",
      "description": "Document the endpoint",
      "relations": [{ "type": "parent", "target": "feature" }]
    },
    {
      "key": "validate",
      "subject": "Validate feature",
      "description": "Run checks after implementation and docs",
      "blockedBy": ["api", "docs"],
      "relations": [
        { "type": "parent", "target": "feature" },
        { "type": "validates", "target": "feature" }
      ]
    }
  ]
}
```

## Task Storage

Task storage is controlled by the `taskScope` setting (`/tasks` → Settings → Task storage):

| Mode | File | Behaviour |
|------|------|-----------|
| `memory` | *(none)* | In-memory only — tasks lost when session ends |
| `session` **(default)** | `<cwd>/.pi/tasks/tasks-<sessionId>.json` | Per-session file — isolated between sessions, survives resume |
| `project` | `<cwd>/.pi/tasks/tasks.json` | Shared across all sessions in the project |

On new session start, if all persisted tasks are completed they are auto-cleared for a clean slate. On session resume, all tasks (including completed) are shown so the user can review progress. Empty session files are automatically deleted when all tasks are cleared.

### Auto-clear completed tasks

The `autoClearCompleted` setting controls automatic cleanup of completed tasks:

| Mode | Behaviour |
|------|-----------|
| `never` | Completed tasks stay visible until manually cleared via `/tasks` → Clear completed |
| `on_list_complete` **(default)** | Cleared after all tasks are done and a few idle turns pass |
| `on_task_complete` | Each completed task cleared individually after a few turns |

Both auto-clear modes use a turn-based delay for non-jarring UX — tasks linger briefly so you see the completion before they disappear.

Settings (`taskScope`, `autoCascade`, `autoClearCompleted`) are saved to `<cwd>/.pi/tasks-config.json`.

### Override via environment variables

| Variable | Value | Behaviour |
|----------|-------|-----------|
| `PI_TASKS` | `off` | In-memory only (CI/automation) |
| `PI_TASKS` | `sprint-1` | Named shared list at `~/.pi/tasks/sprint-1.json` |
| `PI_TASKS` | `/abs/path/tasks.json` | Explicit absolute file path |
| `PI_TASKS` | `./tasks.json` | Relative path resolved from cwd |
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
- **Settings** — configure task storage, auto-cascade, and auto-clear completed tasks (saved to `tasks-config.json`)

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

If [`pi-subagents`](https://github.com/tintinweb/pi-subagents) is not installed, everything works except `TaskExecute`, which returns a friendly error message. All core task tools (create, list, get, update, dependencies, widget, system-reminder injection) function independently.

## Architecture

```
src/
├── index.ts            # Extension entry: 7 tools + /tasks command + widget + subagent integration
├── types.ts            # Task, TaskStatus, BackgroundProcess types
├── task-store.ts       # File-backed store with CRUD, dependencies, locking
├── auto-clear.ts       # Turn-based auto-clearing of completed tasks (AutoClearManager)
├── tasks-config.ts     # Config persistence (taskScope, autoCascade, autoClearCompleted) → .pi/tasks-config.json
├── process-tracker.ts  # Background process output buffering and stop
└── ui/
    ├── task-widget.ts  # Persistent widget with status icons and spinner
    └── settings-menu.ts  # /tasks → Settings panel (SettingsList TUI component)
```

## Future Work

- **Background Bash auto-task creation** — Claude Code auto-creates tasks when `Bash` runs with `run_in_background: true`. Pi's bash tool currently lacks a `run_in_background` parameter (only `command` + `timeout`), so there's nothing to hook into. Once pi adds background execution support to its bash tool, we can use the `tool_call` event to detect it and auto-create tasks via `TaskStore`/`ProcessTracker`.

## Development

```bash
npm install
npm run typecheck   # TypeScript validation
npm test            # Run unit tests (145 tests)
```

## License

MIT — [tintinweb](https://github.com/tintinweb)
