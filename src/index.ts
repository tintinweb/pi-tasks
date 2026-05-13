/**
 * @tintinweb/pi-tasks — A pi extension providing Claude Code-style task tracking and coordination.
 *
 * Tools:
 *   TaskCreate   — Create a structured task
 *   TaskList     — List all tasks with status
 *   TaskGet      — Get full task details
 *   TaskUpdate   — Update task fields, status, dependencies
 *   TaskOutput   — Get output from a background task process
 *   TaskStop     — Stop a running background task process
 *   TaskExecute  — Execute tasks as subagents (requires @tintinweb/pi-subagents)
 *
 * Commands:
 *   /tasks       — Interactive task management menu
 */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AutoClearManager } from "./auto-clear.js";
import { ProcessTracker } from "./process-tracker.js";
import { TaskStore } from "./task-store.js";
import { loadTasksConfig } from "./tasks-config.js";
import { openSettingsMenu } from "./ui/settings-menu.js";
import { TaskWidget, type UICtx } from "./ui/task-widget.js";

// ---- Debug ----

const DEBUG = !!process.env.PI_TASKS_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-tasks]", ...args);
}

// ---- Helpers ----

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

/** Task tool names — used to detect task tool usage for reminder suppression. */
const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop", "TaskExecute"]);

/** How many turns without task tool usage before injecting a reminder. */
const REMINDER_INTERVAL = 4;

/** How many turns completed tasks linger before auto-clearing. */
const AUTO_CLEAR_DELAY = 4;

const SYSTEM_REMINDER = `<system-reminder>
The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user
</system-reminder>`;

export default function (pi: ExtensionAPI) {
  // Initialize store and config
  const cfg = loadTasksConfig();
  const piTasks = process.env.PI_TASKS;
  const taskScope = cfg.taskScope ?? "session";

  /** Resolve the task store path from env/config (without session ID). */
  function resolveStorePath(sessionId?: string): string | undefined {
    if (piTasks === "off") return undefined;
    if (piTasks?.startsWith("/")) return piTasks;
    if (piTasks?.startsWith(".")) return resolve(piTasks);
    if (piTasks) return piTasks;
    if (taskScope === "memory") return undefined;
    if (taskScope === "session" && sessionId) {
      return join(process.cwd(), ".pi", "tasks", `tasks-${sessionId}.json`);
    }
    if (taskScope === "session") return undefined; // no session ID yet, start in-memory
    return join(process.cwd(), ".pi", "tasks", "tasks.json");
  }

  // For project scope (or env override), create store immediately.
  // For session scope, start with in-memory and upgrade once we have the session ID.
  let store = new TaskStore(resolveStorePath());
  const tracker = new ProcessTracker();
  const widget = new TaskWidget(store, cfg);

  // ── Subagent integration state ──
  /** Latest ExtensionContext — refreshed on every tool execution so cascade always has a valid one. */
  let latestCtx: ExtensionContext | undefined;
  /** Cascade config — set by TaskExecute, consumed by completion listener. */
  let cascadeConfig: { additionalContext?: string; model?: string; maxTurns?: number } | undefined;
  /** Maps agent IDs to task IDs for O(1) completion lookup. */
  const agentTaskMap = new Map<string, string>();

  // ── Subagent RPC helpers ──

  /** RPC reply envelope — matches pi-mono's RpcResponse shape. */
  type RpcReply<T = void> =
    | { success: true; data?: T }
    | { success: false; error: string };

  /** Call a subagents RPC method: emit request, wait for scoped reply, unwrap envelope. */
  function rpcCall<T>(channel: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const requestId = randomUUID();
    debug(`rpc:send ${channel}`, { requestId });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        debug(`rpc:timeout ${channel}`, { requestId });
        reject(new Error(`${channel} timeout`));
      }, timeoutMs);
      const unsub = pi.events.on(`${channel}:reply:${requestId}`, (raw: unknown) => {
        unsub(); clearTimeout(timer);
        debug(`rpc:reply ${channel}`, { requestId, raw });
        const reply = raw as RpcReply<T>;
        if (reply.success) resolve(reply.data as T);
        else reject(new Error(reply.error));
      });
      pi.events.emit(channel, { requestId, ...params });
      debug(`rpc:emitted ${channel}`, { requestId });
    });
  }

  /** Spawn a subagent via pi.events RPC (requires @tintinweb/pi-subagents extension). */
  function spawnSubagent(type: string, prompt: string, options?: any): Promise<string> {
    debug("spawn:call", { type, options: { ...options, prompt: undefined } });
    return rpcCall<{ id: string }>("subagents:rpc:spawn", { type, prompt, options }, 30_000)
      .then(d => { debug("spawn:ok", d); return d.id; });
  }

  /** Stop a subagent via pi.events RPC (requires @tintinweb/pi-subagents extension). */
  function stopSubagent(agentId: string): Promise<void> {
    return rpcCall<void>("subagents:rpc:stop", { agentId }, 10_000).catch(() => {});
  }

  // ── Subagent extension presence & version detection ──
  const PROTOCOL_VERSION = 2;
  let subagentsAvailable = false;
  let pendingWarning: string | undefined;

  /** Ping subagents and check protocol version. Works with any handler version. */
  function checkSubagentsVersion() {
    const requestId = randomUUID();
    const timer = setTimeout(() => { unsub(); }, 5_000);
    const unsub = pi.events.on(`subagents:rpc:ping:reply:${requestId}`, (raw: unknown) => {
      unsub(); clearTimeout(timer);
      const remoteVersion = (raw as any)?.data?.version as number | undefined;
      if (remoteVersion === undefined) {
        pendingWarning =
          "@tintinweb/pi-subagents is outdated — please update for task execution support.";
      } else if (remoteVersion > PROTOCOL_VERSION) {
        pendingWarning =
          `@tintinweb/pi-tasks is outdated (protocol v${PROTOCOL_VERSION}, ` +
          `pi-subagents has v${remoteVersion}) — please update for task execution support.`;
      } else if (remoteVersion < PROTOCOL_VERSION) {
        pendingWarning =
          `@tintinweb/pi-subagents is outdated (protocol v${remoteVersion}, ` +
          `pi-tasks has v${PROTOCOL_VERSION}) — please update for task execution support.`;
      } else {
        subagentsAvailable = true;
      }
    });
    pi.events.emit("subagents:rpc:ping", { requestId });
  }

  checkSubagentsVersion();
  pi.events.on("subagents:ready", () => checkSubagentsVersion());

  /** Build a prompt for a task being executed by a subagent.
   *  Injects completed dependency results so cascaded agents have context from prerequisites.
   */
  function buildTaskPrompt(
    task: { id: string; subject: string; description: string; blockedBy?: string[] },
    additionalContext?: string,
  ): string {
    let prompt = `You are executing task #${task.id}: "${task.subject}"\n\n${task.description}`;

    // Inject completed dependency results so cascaded agents have full context
    if (task.blockedBy && task.blockedBy.length > 0) {
      const depResults: string[] = [];
      for (const depId of task.blockedBy) {
        const dep = store.get(depId);
        if (dep?.metadata?.result) {
          const result = dep.metadata.result.length > 4000
            ? dep.metadata.result.slice(0, 4000) + "\n\n[... truncated — use TaskGet for full output]"
            : dep.metadata.result;
          depResults.push(`### Task #${depId}: ${dep.subject}\n${result}`);
        }
      }
      if (depResults.length > 0) {
        prompt += `\n\n## Prerequisite task results\n\n${depResults.join("\n\n")}`;
      }
    }

    if (additionalContext) prompt += `\n\n${additionalContext}`;
    prompt += `\n\nComplete this task fully. Do not attempt to manage tasks yourself.`;
    return prompt;
  }

  const autoClear = new AutoClearManager(() => store, () => cfg.autoClearCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY);

  // ── Subagent completion listener ──
  // Listens for subagent lifecycle events to update task status and optionally cascade.

  // Success → mark task completed, cascade if enabled
  pi.events.on("subagents:completed", async (data) => {
    const { id, result } = data as { id: string; result?: string };
    const taskId = agentTaskMap.get(id);
    if (!taskId) return;
    agentTaskMap.delete(id);
    const task = store.get(taskId);
    if (!task) return;

    store.update(task.id, { status: "completed", metadata: { ...task.metadata, result } });
    widget.setActiveTask(task.id, false);

    // Auto-cascade: find unblocked dependents with agentType
    if ((cfg.autoCascade ?? false) && cascadeConfig && latestCtx) {
      const unblocked = store.list().filter(t =>
        t.status === "pending" &&
        t.metadata?.agentType &&
        t.blockedBy.includes(task.id) &&
        t.blockedBy.every(depId => store.get(depId)?.status === "completed")
      );
      for (const next of unblocked) {
        store.update(next.id, { status: "in_progress" });
        const prompt = buildTaskPrompt(next, cascadeConfig.additionalContext);
        try {
          const agentId = await spawnSubagent(next.metadata.agentType, prompt, {
            description: next.subject,
            isBackground: true,
            maxTurns: cascadeConfig.maxTurns,
            ...(cascadeConfig.model ? { model: cascadeConfig.model } : {}),
          });
          agentTaskMap.set(agentId, next.id);
          store.update(next.id, { owner: agentId, metadata: { ...next.metadata, agentId } });
          widget.setActiveTask(next.id);
        } catch (err: any) {
          store.update(next.id, { status: "pending", metadata: { ...next.metadata, lastError: err.message } });
        }
      }
    }
    autoClear.trackCompletion(task.id, currentTurn);
    widget.update();
  });

  // Failure → store error, revert to pending, don't cascade (branch stops)
  // Intentional stop (status === "stopped") → mark completed, preserve partial result
  pi.events.on("subagents:failed", (data) => {
    const { id, error, result, status } = data as { id: string; error?: string; result?: string; status: string };
    const taskId = agentTaskMap.get(id);
    if (!taskId) return;
    agentTaskMap.delete(id);
    const task = store.get(taskId);
    if (!task) return;

    if (status === "stopped") {
      // Intentional stop — mark completed, preserve partial result
      store.update(task.id, { status: "completed", metadata: { ...task.metadata, result: result || task.metadata?.result } });
      autoClear.trackCompletion(task.id, currentTurn);
    } else {
      // Actual error — revert to pending
      store.update(task.id, { status: "pending", metadata: { ...task.metadata, lastError: error || status } });
      autoClear.resetBatchCountdown();
    }
    widget.setActiveTask(task.id, false);
    widget.update();
  });

  // ── Session-scoped store upgrade ──
  // For session scope, the store starts in-memory (no session ID at init time).
  // Upgrade to file-backed on first context arrival (turn_start, before_agent_start,
  // or tool_execution_start — whichever fires first).
  let storeUpgraded = false;
  let persistedTasksShown = false;
  function upgradeStoreIfNeeded(ctx: ExtensionContext) {
    if (storeUpgraded) return;
    if (taskScope === "session" && !piTasks) {
      const sessionId = ctx.sessionManager.getSessionId();
      const path = resolveStorePath(sessionId);
      store = new TaskStore(path);
      widget.setStore(store);
    }
    storeUpgraded = true;
  }

  /** Restore widget on session start/resume if there's unfinished work.
   *  On new sessions, auto-clear if all tasks are completed (clean slate).
   *  On resume, always show tasks (user may want to review).
   *  Only runs once — the first caller wins. */
  function showPersistedTasks(isResume = false) {
    if (persistedTasksShown) return;
    persistedTasksShown = true;
    const tasks = store.list();
    if (tasks.length > 0) {
      if (!isResume && tasks.every(t => t.status === "completed")) {
        store.clearCompleted();
        if (taskScope === "session") store.deleteFileIfEmpty();
      } else {
        widget.update();
      }
    }
  }

  // ── Turn tracking for system-reminder injection ──
  let currentTurn = 0;
  let lastTaskToolUseTurn = 0;
  let reminderInjectedThisCycle = false;

  pi.on("turn_start", async (_event, ctx) => {
    currentTurn++;
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    if (autoClear.onTurnStart(currentTurn)) widget.update();
  });

  // ── Token usage tracking ──
  // Feed per-turn token counts from assistant messages into the widget.
  pi.on("turn_end", async (event) => {
    const msg = event.message as any;
    if (msg?.role === "assistant" && msg.usage) {
      widget.addTokenUsage(msg.usage.input ?? 0, msg.usage.output ?? 0);
    }
  });

  // ── System-reminder injection via tool_result event ──
  // Appends a <system-reminder> nudge to non-task tool results when tasks exist
  // but task tools haven't been used recently (mimics Claude Code's behavior).
  pi.on("tool_result", async (event) => {
    // Task tool usage resets the reminder timer
    if (TASK_TOOL_NAMES.has(event.toolName)) {
      lastTaskToolUseTurn = currentTurn;
      reminderInjectedThisCycle = false;
      return {};
    }

    // Cheap checks first — avoid store.list() disk I/O when possible
    if (currentTurn - lastTaskToolUseTurn < REMINDER_INTERVAL) return {};
    if (reminderInjectedThisCycle) return {};

    const tasks = store.list();
    if (tasks.length === 0) return {};

    // Append system-reminder to tool result content.
    // Reset the baseline so the next reminder fires REMINDER_INTERVAL turns later.
    reminderInjectedThisCycle = true;
    lastTaskToolUseTurn = currentTurn;
    return {
      content: [...event.content, { type: "text" as const, text: SYSTEM_REMINDER }],
    };
  });

  // Grab UI context early — before_agent_start fires before any tool calls,
  // so persisted tasks show up immediately on session start.
  pi.on("before_agent_start", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    showPersistedTasks();
    if (pendingWarning) {
      ctx.ui.notify(pendingWarning, "warning");
      pendingWarning = undefined;
    }
  });

  // session_switch fires on /new (reason: "new") and /resume (reason: "resume").
  // On /new: reset all session-scoped state so the store switches to the new session file.
  // On resume: reload persisted tasks from the existing session file.
  pi.on("session_switch" as any, async (event: any, ctx: ExtensionContext) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);

    const isResume = event?.reason === "resume";

    // Reset session-scoped state for both /new and /resume
    storeUpgraded = false;
    persistedTasksShown = false;
    currentTurn = 0;
    lastTaskToolUseTurn = 0;
    reminderInjectedThisCycle = false;
    autoClear.reset();

    // Memory mode has no file-backed store to switch — clear explicitly on /new
    if (!isResume && taskScope === "memory") {
      store.clearAll();
    }

    upgradeStoreIfNeeded(ctx);
    showPersistedTasks(isResume);
  });

  // Keep latestCtx fresh on every tool execution as well.
  pi.on("tool_execution_start", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    widget.update();
  });

  // ──────────────────────────────────────────────────
  // Tool 1: TaskCreate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Detailed description of what needs to be done, including context and acceptance criteria
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- Include enough detail in the description for another agent to understand and complete the task
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
- Check TaskList first to avoid creating duplicate tasks
- Include \`agentType\` (e.g., "general-purpose", "Explore") to mark tasks for subagent execution via TaskExecute`,
    promptGuidelines: [
      "When working on complex multi-step tasks, use TaskCreate to track progress and TaskUpdate to update status.",
      "Mark tasks as in_progress before starting work and completed when done.",
      "Use TaskList to check for available work after completing a task.",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "A brief title for the task" }),
      description: Type.String({ description: "A detailed description of what needs to be done" }),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress (e.g., 'Running tests')" })),
      agentType: Type.Optional(Type.String({ description: "Agent type for subagent execution (e.g., 'general-purpose', 'Explore'). Tasks with agentType can be started via TaskExecute." })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      autoClear.resetBatchCountdown();
      const meta = params.metadata ?? {};
      if (params.agentType) meta.agentType = params.agentType;
      const task = store.create(params.subject, params.description, params.activeForm, Object.keys(meta).length > 0 ? meta : undefined);
      widget.update();
      return Promise.resolve(textResult(`Task #${task.id} created successfully: ${task.subject}`));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 2: TaskList
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)

Use TaskGet with a specific task ID to view full details including description and comments.`,
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const tasks = store.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));

      // Sort: pending first (by ID), then in_progress (by ID), then completed (by ID)
      const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
      const sorted = [...tasks].sort((a, b) => {
        const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
        if (so !== 0) return so;
        return Number(a.id) - Number(b.id);
      });

      const lines = sorted.map(task => {
        let line = `#${task.id} [${task.status}] ${task.subject}`;

        if (task.owner) {
          line += ` (${task.owner})`;
        }

        // Only show non-completed blockers
        if (task.blockedBy.length > 0) {
          const openBlockers = task.blockedBy.filter(bid => {
            const blocker = store.get(bid);
            return blocker && blocker.status !== "completed";
          });
          if (openBlockers.length > 0) {
            line += ` [blocked by ${openBlockers.map(id => "#" + id).join(", ")}]`;
          }
        }

        return line;
      });

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 3: TaskGet
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to retrieve" }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = store.get(params.taskId);
      if (!task) return Promise.resolve(textResult(`Task not found`));

      // Unescape literal \n sequences the LLM may have double-escaped in JSON
      const desc = task.description.replace(/\\n/g, "\n");

      const lines: string[] = [
        `Task #${task.id}: ${task.subject}`,
        `Status: ${task.status}`,
      ];
      if (task.owner) {
        lines.push(`Owner: ${task.owner}`);
      }
      lines.push(`Description: ${desc}`);

      if (task.blockedBy.length > 0) {
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          lines.push(`Blocked by: ${openBlockers.map(id => "#" + id).join(", ")}`);
        }
      }
      if (task.blocks.length > 0) {
        lines.push(`Blocks: ${task.blocks.map(id => "#" + id).join(", ")}`);
      }

      // Show metadata if non-empty
      const metaKeys = Object.keys(task.metadata);
      if (metaKeys.length > 0) {
        lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);
      }

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 4: TaskUpdate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Use this tool to update a task in the task list.

## When to Use This Tool

**Before starting work on a task:**
- Mark it in_progress BEFORE beginning — do not start work without updating status first
- After resolving, call TaskList to find your next task

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using \`TaskGet\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\``,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to update" }),
      status: Type.Optional(Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
        type: "string",
        enum: ["pending", "in_progress", "completed", "deleted"],
        description: "New status for the task",
      })),
      subject: Type.Optional(Type.String({ description: "New subject for the task" })),
      description: Type.Optional(Type.String({ description: "New description for the task" })),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
      owner: Type.Optional(Type.String({ description: "New owner for the task" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to merge into the task. Set a key to null to delete it." })),
      addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
      addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { taskId, ...fields } = params;
      const { task, changedFields, warnings } = store.update(taskId, fields);

      if (changedFields.length === 0 && !task) {
        return Promise.resolve(textResult(`Task #${taskId} not found`));
      }

      // Update widget active task tracking
      if (fields.status === "in_progress") {
        widget.setActiveTask(taskId);
        autoClear.resetBatchCountdown();
      } else if (fields.status === "pending") {
        autoClear.resetBatchCountdown();
      } else if (fields.status === "completed" || fields.status === "deleted") {
        widget.setActiveTask(taskId, false);
        if (fields.status === "completed") autoClear.trackCompletion(taskId, currentTurn);
      }

      widget.update();
      let msg = `Updated task #${taskId} ${changedFields.join(", ")}`;
      if (warnings.length > 0) {
        msg += ` (warning: ${warnings.join("; ")})`;
      }
      return Promise.resolve(textResult(msg));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 5: TaskOutput
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskOutput",
    label: "TaskOutput",
    description: `- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions`,
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID to get output from" }),
      block: Type.Boolean({ description: "Whether to wait for completion", default: true }),
      timeout: Type.Number({ description: "Max wait time in ms", default: 30000, minimum: 0, maximum: 600000 }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const { task_id, block, timeout } = params;

      const processOutput = tracker.getOutput(task_id);
      if (!processOutput) {
        // No shell process — check if this is a subagent task
        // Support both task IDs and agent IDs (resolve agent ID → task ID)
        let resolvedId = task_id;
        if (!store.get(resolvedId)) {
          // Check if this is an agent ID mapped to a task
          for (const [agentId, taskId] of agentTaskMap) {
            if (agentId === task_id || agentId.startsWith(task_id)) { resolvedId = taskId; break; }
          }
        }
        const task = store.get(resolvedId);
        if (!task) throw new Error(`No task found with ID ${task_id}`);

        if (task.metadata?.agentId) {
          // Subagent task — wait for completion if blocking
          if (block && task.status === "in_progress") {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => { unsubOk(); unsubFail(); resolve(); }, timeout ?? 30000);
              const cleanup = () => { clearTimeout(timer); resolve(); };
              const unsubOk = pi.events.on("subagents:completed", (d: unknown) => {
                if ((d as any).id === task.metadata?.agentId) { unsubOk(); unsubFail(); cleanup(); }
              });
              const unsubFail = pi.events.on("subagents:failed", (d: unknown) => {
                if ((d as any).id === task.metadata?.agentId) { unsubOk(); unsubFail(); cleanup(); }
              });
              // Re-check in case status changed between the outer check and listener registration
              const current = store.get(task_id);
              if (current && current.status !== "in_progress") { unsubOk(); unsubFail(); cleanup(); }
              signal?.addEventListener("abort", () => { unsubOk(); unsubFail(); cleanup(); }, { once: true });
            });
          }
          const updated = store.get(task_id) ?? task;
          return textResult(`Task #${task_id} [${updated.status}] — subagent ${task.metadata.agentId}`);
        }
        throw new Error(`No background process for task ${task_id}`);
      }

      if (block && processOutput.status === "running") {
        const result = await tracker.waitForCompletion(task_id, timeout ?? 30000, signal ?? undefined);
        if (result) {
          return textResult(
            `Task #${task_id} (${result.status})${result.exitCode !== undefined ? ` exit code: ${result.exitCode}` : ""}\n\n${result.output}`,
          );
        }
      }

      return textResult(
        `Task #${task_id} (${processOutput.status})${processOutput.exitCode !== undefined ? ` exit code: ${processOutput.exitCode}` : ""}\n\n${processOutput.output}`,
      );
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 6: TaskStop
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskStop",
    label: "TaskStop",
    description: `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task`,
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
      shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const taskId = params.task_id ?? params.shell_id;
      if (!taskId) throw new Error("task_id is required");

      const stopped = await tracker.stop(taskId);
      if (!stopped) {
        // No shell process — check if this is a subagent task
        // Support both task IDs and agent IDs
        let resolvedId = taskId;
        if (!store.get(resolvedId)) {
          for (const [agentId, tId] of agentTaskMap) {
            if (agentId === taskId || agentId.startsWith(taskId)) { resolvedId = tId; break; }
          }
        }
        const task = store.get(resolvedId);
        if (task?.metadata?.agentId && task.status === "in_progress") {
          store.update(taskId, { status: "completed" });
          autoClear.trackCompletion(taskId, currentTurn);
          await stopSubagent(task.metadata.agentId);
          widget.setActiveTask(taskId, false);
          widget.update();
          return textResult(`Task #${taskId} stopped successfully`);
        }
        throw new Error(`No running background process for task ${taskId}`);
      }

      store.update(taskId, { status: "completed" });
      autoClear.trackCompletion(taskId, currentTurn);
      widget.setActiveTask(taskId, false);
      widget.update();
      return textResult(`Task #${taskId} stopped successfully`);
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 7: TaskExecute
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskExecute",
    label: "TaskExecute",
    description: `Execute one or more tasks as subagents.

## When to Use This Tool

- To start execution of tasks that have \`agentType\` set (created via TaskCreate with agentType parameter)
- Tasks must be \`pending\` with all blockedBy dependencies \`completed\`
- Each task runs as an independent background subagent

## Parameters

- **task_ids**: Array of task IDs to execute
- **additional_context**: Extra context appended to each agent's prompt
- **model**: Model override for agents (e.g., "sonnet", "haiku")
- **max_turns**: Maximum turns per agent`,
    promptGuidelines: [
      "Never use the Agent tool for tasks launched via TaskExecute — agents are already running.",
    ],
    parameters: Type.Object({
      task_ids: Type.Array(Type.String(), { description: "Task IDs to execute as subagents" }),
      additional_context: Type.Optional(Type.String({ description: "Extra context for agent prompts" })),
      model: Type.Optional(Type.String({ description: "Model override for agents" })),
      max_turns: Type.Optional(Type.Number({ description: "Max turns per agent", minimum: 1 })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!subagentsAvailable) {
        return textResult(
          "Subagent execution is currently unavailable. " +
          "Ensure the @tintinweb/pi-subagents extension is loaded and try again."
        );
      }

      const results: string[] = [];
      const launched: string[] = [];

      for (const taskId of params.task_ids) {
        const task = store.get(taskId);
        if (!task) {
          results.push(`#${taskId}: not found`);
          continue;
        }
        if (task.status !== "pending") {
          results.push(`#${taskId}: not pending (status: ${task.status})`);
          continue;
        }
        if (!task.metadata?.agentType) {
          results.push(`#${taskId}: no agentType set — create with agentType parameter or update metadata`);
          continue;
        }

        // Check all blockers are completed
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = store.get(bid);
          return !blocker || blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          results.push(`#${taskId}: blocked by ${openBlockers.map(id => "#" + id).join(", ")}`);
          continue;
        }

        // Mark in_progress and spawn agent via RPC
        store.update(taskId, { status: "in_progress" });
        const prompt = buildTaskPrompt(task, params.additional_context);
        try {
          const agentId = await spawnSubagent(task.metadata.agentType, prompt, {
            description: task.subject,
            isBackground: true,
            maxTurns: params.max_turns,
            ...(params.model ? { model: params.model } : {}),
          });
          agentTaskMap.set(agentId, taskId);
          store.update(taskId, { owner: agentId, metadata: { ...task.metadata, agentId } });
          widget.setActiveTask(taskId);
          launched.push(`#${taskId} → agent ${agentId}`);
        } catch (err: any) {
          debug(`spawn:error task=#${taskId}`, err);
          store.update(taskId, { status: "pending" });
          results.push(`#${taskId}: spawn failed — ${err.message}`);
        }
      }

      // Save cascade config for the completion listener
      cascadeConfig = {
        additionalContext: params.additional_context,
        model: params.model,
        maxTurns: params.max_turns,
      };

      widget.update();

      const lines: string[] = [];
      if (launched.length > 0) {
        lines.push(
          `Launched ${launched.length} agent(s):\n${launched.join("\n")}\n` +
          `Use TaskOutput to check progress. Do not spawn additional agents for these tasks.`
        );
      }
      if (results.length > 0) lines.push(`Skipped:\n${results.join("\n")}`);
      if (lines.length === 0) lines.push("No tasks to execute.");

      return textResult(lines.join("\n\n"));
    },
  });

  // ──────────────────────────────────────────────────
  // /tasks command
  // ──────────────────────────────────────────────────

  pi.registerCommand("tasks", {
    description: "Manage tasks — view, create, clear completed",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const ui = ctx.ui;

      const mainMenu = async (): Promise<void> => {
        const tasks = store.list();
        const taskCount = tasks.length;
        const completedCount = tasks.filter(t => t.status === "completed").length;

        const choices: string[] = [
          `View all tasks (${taskCount})`,
          "Create task",
        ];
        if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
        if (taskCount > 0) choices.push(`Clear all (${taskCount})`);
        choices.push("Settings");

        const choice = await ui.select("Tasks", choices);
        if (!choice) return;

        if (choice.startsWith("View")) {
          await viewTasks();
        } else if (choice === "Create task") {
          await createTask();
        } else if (choice === "Settings") {
          await settingsMenu();
        } else if (choice.startsWith("Clear completed")) {
          store.clearCompleted();
          if (taskScope === "session") store.deleteFileIfEmpty();
          widget.update();
          await mainMenu();
        } else if (choice.startsWith("Clear all")) {
          store.clearAll();
          if (taskScope === "session") store.deleteFileIfEmpty();
          widget.update();
          await mainMenu();
        }
      };

      const viewTasks = async (): Promise<void> => {
        const tasks = store.list();
        if (tasks.length === 0) {
          await ui.select("No tasks", ["← Back"]);
          return mainMenu();
        }

        const statusIcon = (status: string) => {
          switch (status) {
            case "completed": return "✔";
            case "in_progress": return "◼";
            default: return "◻";
          }
        };

        const choices = tasks.map(t =>
          `${statusIcon(t.status)} #${t.id} [${t.status}] ${t.subject}`
        );
        choices.push("← Back");

        const selected = await ui.select("Tasks", choices);
        if (!selected || selected === "← Back") return mainMenu();

        // Extract task ID from selection
        const match = selected.match(/#(\d+)/);
        if (match) await viewTaskDetail(match[1]);
        else return viewTasks();
      };

      const viewTaskDetail = async (taskId: string): Promise<void> => {
        const task = store.get(taskId);
        if (!task) return viewTasks();

        const actions: string[] = [];

        if (task.status === "pending") {
          actions.push("▸ Start (in_progress)");
        }
        if (task.status === "in_progress") {
          actions.push("✓ Complete");
        }
        actions.push("✗ Delete");
        actions.push("← Back");

        const title = `#${task.id} [${task.status}] ${task.subject}\n${task.description}`;
        const action = await ui.select(title, actions);

        if (action === "▸ Start (in_progress)") {
          store.update(taskId, { status: "in_progress" });
          widget.setActiveTask(taskId);
          widget.update();
          return viewTasks();
        } else if (action === "✓ Complete") {
          store.update(taskId, { status: "completed" });
          autoClear.trackCompletion(taskId, currentTurn);
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        } else if (action === "✗ Delete") {
          store.update(taskId, { status: "deleted" });
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        }
        return viewTasks();
      };

      const settingsMenu = (): Promise<void> =>
        openSettingsMenu(ui, cfg, mainMenu, AUTO_CLEAR_DELAY);

      const createTask = async (): Promise<void> => {
        const subject = await ui.input("Task subject");
        if (!subject) return mainMenu();
        const description = await ui.input("Task description");
        if (!description) return mainMenu();

        store.create(subject, description);
        widget.update();
        return mainMenu();
      };

      await mainMenu();
    },
  });
}
