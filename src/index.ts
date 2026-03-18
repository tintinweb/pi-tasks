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

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { TaskStore } from "./task-store.js";
import { ProcessTracker } from "./process-tracker.js";
import { TaskWidget, type UICtx } from "./ui/task-widget.js";
import { loadTasksConfig } from "./tasks-config.js";
import { isTerminalStatus, type TaskBudget, type TaskStatus } from "./types.js";
import { openSettingsMenu } from "./ui/settings-menu.js";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

// ---- Helpers ----

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined };
}

/** Format a task as a multi-line detail string (reused by TaskCreate and TaskGet). */
function formatTaskDetail(task: { id: string; subject: string; description: string; status: string; owner?: string; blockedBy: string[]; blocks: string[] }): string {
  const lines: string[] = [
    `Task #${task.id}: ${task.subject}`,
    `Status: ${task.status}`,
  ];
  if (task.owner) lines.push(`Owner: ${task.owner}`);
  const desc = task.description.replace(/\\n/g, "\n");
  lines.push(`Description: ${desc}`);
  if (task.blockedBy.length > 0) lines.push(`Blocked by: ${task.blockedBy.map(id => "#" + id).join(", ")}`);
  if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.map(id => "#" + id).join(", ")}`);
  return lines.join("\n");
}

/** Task tool names — used to detect task tool usage for reminder suppression. */
const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskCreateMany", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop", "TaskExecute"]);

/** How many turns without task tool usage before injecting a reminder. */
const REMINDER_INTERVAL = 4;

const SYSTEM_REMINDER = `<system-reminder>
The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user
</system-reminder>`;

export default function (pi: ExtensionAPI) {
  // ── Duplicate installation detection ──
  try {
    const gitInstallPath = join(homedir(), ".pi", "agent", "git", "pi-tasks");
    const hasGitInstall = existsSync(gitInstallPath);
    const isNpmGlobal = import.meta.url?.includes("node_modules");
    if (hasGitInstall && isNpmGlobal) {
      console.warn("[pi-tasks] Warning: detected both git (~/.pi/agent/git/pi-tasks) and npm global installations. This may cause conflicts — consider removing one.");
    }
  } catch { /* Non-fatal: detection is best-effort advisory */ }

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
  const widget = new TaskWidget(store);

  // ── Subagent integration state ──
  /** Latest ExtensionContext — refreshed on every tool execution so cascade always has a valid one. */
  let latestCtx: ExtensionContext | undefined;
  /** Per-task cascade config — set by TaskExecute, consumed by completion listener. */
  const taskCascadeConfigs = new Map<string, { additionalContext?: string; model?: string; maxTurns?: number }>();
  /** Maps agent IDs to task IDs for O(1) completion lookup. */
  const agentTaskMap = new Map<string, string>();

  // ── Task-level budget/timeout tracking ──
  const taskBudgets = new Map<string, TaskBudget>();

  function clearTaskBudget(taskId: string) {
    const budget = taskBudgets.get(taskId);
    if (budget?.timer) clearTimeout(budget.timer);
    taskBudgets.delete(taskId);
    widget.clearBudget(taskId);
  }

  // ── Subagent extension presence detection ──
  // Two paths: (1) listen for ready broadcast (subagents loads first),
  //            (2) send ping on our init (tasks loads first).
  let subagentsAvailable = false;

  // Ping subagents extension — scoped reply channel, no filtering needed
  const pingId = randomUUID();
  const unsubPing = pi.events.on(`subagents:rpc:ping:reply:${pingId}`, () => {
    subagentsAvailable = true;
    unsubPing();
  });
  pi.events.emit("subagents:rpc:ping", { requestId: pingId });

  // Also listen for ready broadcast (covers: subagents loads after us)
  const unsubReady = pi.events.on("subagents:ready", () => {
    subagentsAvailable = true;
    unsubReady();  // self-remove to prevent listener leak
    unsubPing();   // clean up ping listener if still pending
  });

  /** Spawn a subagent via pi.events RPC (requires @tintinweb/pi-subagents extension). */
  function spawnSubagent(type: string, prompt: string, options?: any, signal?: AbortSignal): Promise<string> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { cleanup(); reject(new Error("subagents:rpc:spawn timeout")); }, 30000);
      const unsub = pi.events.on(`subagents:rpc:spawn:reply:${requestId}`, (p: unknown) => {
        if (settled) return;
        const { id, error } = p as { id?: string; error?: string };
        cleanup();
        if (error) reject(new Error(error));
        else resolve(id!);
      });

      function cleanup() {
        if (settled) return;
        settled = true;
        unsub();
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        activeSpawnCleanups.delete(cleanup);
      }

      activeSpawnCleanups.add(cleanup);

      function onAbort() {
        cleanup();
        reject(new DOMException("The operation was aborted", "AbortError"));
      }

      if (signal?.aborted) {
        cleanup();
        reject(new DOMException("The operation was aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      pi.events.emit("subagents:rpc:spawn", { requestId, type, prompt, options });
    });
  }

  /** Build a prompt for a task being executed by a subagent. */
  function buildTaskPrompt(task: { id: string; subject: string; description: string }, additionalContext?: string): string {
    let prompt = `You are executing task #${task.id}: "${task.subject}"\n\n${task.description}`;
    if (additionalContext) prompt += `\n\n${additionalContext}`;
    prompt += `\n\nComplete this task fully. Do not attempt to manage tasks yourself.`;
    return prompt;
  }

  // ── Subagent completion listener ──
  // Listens for subagent lifecycle events to update task status and optionally cascade.

  // Collect event bus unsub handles for dispose()
  const eventUnsubs: Array<() => void> = [];
  // Track in-flight spawn RPC cleanup functions for dispose()
  const activeSpawnCleanups = new Set<() => void>();

  // Success → mark task completed, cascade if enabled
  eventUnsubs.push(pi.events.on("subagents:completed", async (data) => {
    const { id, result } = data as { id: string; result?: string };
    const taskId = agentTaskMap.get(id);
    if (!taskId) return;
    agentTaskMap.delete(id);
    const task = store.get(taskId);
    if (!task) return;

    store.update(task.id, { status: "completed", metadata: { ...task.metadata, result } });
    widget.setActiveTask(task.id, false);
    clearTaskBudget(taskId);

    // Auto-cascade: find unblocked dependents with agentType
    const cascadeConfig = taskCascadeConfigs.get(taskId);
    taskCascadeConfigs.delete(taskId);
    if ((cfg.autoCascade ?? false) && cascadeConfig && latestCtx) {
      const unblocked = store.list().filter(t =>
        t.status === "pending" &&
        t.metadata?.agentType &&
        t.blockedBy.includes(task.id) &&
        t.blockedBy.every(depId => { const blocker = store.get(depId); return !blocker || isTerminalStatus(blocker.status); })
      );
      for (const next of unblocked) {
        store.update(next.id, { status: "in_progress" });
        const prompt = buildTaskPrompt(next, cascadeConfig.additionalContext);
        try {
          const agentId = await spawnSubagent(next.metadata.agentType, prompt, {
            description: next.subject,
            isBackground: true,
            maxTurns: cascadeConfig.maxTurns,
            ...(cascadeConfig.model && { model: cascadeConfig.model }),
          });
          agentTaskMap.set(agentId, next.id);
          store.update(next.id, { owner: agentId, metadata: { ...next.metadata, agentId } });
          widget.setActiveTask(next.id);
          // Propagate cascade config to dependent task
          taskCascadeConfigs.set(next.id, cascadeConfig);
        } catch (err: any) {
          store.update(next.id, { status: "pending", metadata: { ...next.metadata, lastError: err.message } });
        }
      }
    }
    widget.update();
  }));

  // Failure → store error, revert to pending, don't cascade (branch stops)
  eventUnsubs.push(pi.events.on("subagents:failed", (data) => {
    const { id, error, status } = data as { id: string; error?: string; status: string };
    const taskId = agentTaskMap.get(id);
    if (!taskId) return;
    agentTaskMap.delete(id);
    const task = store.get(taskId);
    if (!task) return;
    store.update(task.id, {
      status: "pending",
      metadata: { ...task.metadata, lastError: error || status },
    });
    widget.setActiveTask(task.id, false);
    clearTaskBudget(taskId);
    taskCascadeConfigs.delete(taskId);
    widget.update();
  }));

  // ── Task RPC handlers ──
  // Allow other extensions (e.g., plan-executor) to create/update tasks
  // via the event bus, following the same request/reply pattern as
  // subagents:rpc:*.

  // Ping: presence detection
  eventUnsubs.push(pi.events.on("tasks:rpc:ping", (payload: unknown) => {
    const { requestId } = payload as { requestId: string };
    pi.events.emit(`tasks:rpc:ping:reply:${requestId}`, {});
  }));

  // createMany: batch create tasks with optional deps
  eventUnsubs.push(pi.events.on("tasks:rpc:createMany", (payload: unknown) => {
    const p = payload as Record<string, unknown> | undefined;
    if (!p || typeof p.requestId !== "string" || !Array.isArray(p.tasks)) return;
    const requestId = p.requestId;
    const taskDefs = p.tasks as Array<{
      subject: string;
      description: string;
      activeForm?: string;
      metadata?: Record<string, any>;
      status?: TaskStatus;
      blockedBy?: string[];
      blocks?: string[];
    }>;
    const clear = p.clearCompleted === true;

    const created: Array<{ id: string; blockedBy?: string[]; blocks?: string[] }> = [];
    try {
      if (clear) store.clearCompleted();

      // Create all tasks first, collecting IDs
      for (const def of taskDefs) {
        const task = store.create(
          def.subject,
          def.description,
          def.activeForm,
          def.metadata,
          def.status ? { status: def.status } : undefined,
        );
        created.push({ id: task.id, blockedBy: def.blockedBy, blocks: def.blocks });
      }

      // Wire dependencies (IDs in blockedBy/blocks may reference
      // tasks created in this batch, so we do it after all creates)
      const rpcWarnings: string[] = [];
      for (const c of created) {
        if (c.blockedBy?.length || c.blocks?.length) {
          const result = store.update(c.id, {
            ...(c.blockedBy?.length ? { addBlockedBy: c.blockedBy } : {}),
            ...(c.blocks?.length ? { addBlocks: c.blocks } : {}),
          });
          rpcWarnings.push(...result.warnings);
        }
      }

      widget.update();
      pi.events.emit(`tasks:rpc:createMany:reply:${requestId}`, {
        ids: created.map(c => c.id),
        ...(rpcWarnings.length > 0 && { warnings: rpcWarnings }),
      });
    } catch (err: any) {
      pi.events.emit(`tasks:rpc:createMany:reply:${requestId}`, {
        error: err.message,
        // Partial: tasks created before the error are already persisted
        partialIds: created.map(c => c.id),
      });
    }
  }));

  // update: update a single task
  eventUnsubs.push(pi.events.on("tasks:rpc:update", (payload: unknown) => {
    const p = payload as Record<string, unknown> | undefined;
    if (!p || typeof p.requestId !== "string" || typeof p.taskId !== "string") return;
    const requestId = p.requestId;
    const taskId = p.taskId;
    const fields = (p.fields ?? {}) as {
      status?: TaskStatus | "deleted";
      subject?: string;
      description?: string;
      activeForm?: string;
      owner?: string;
      metadata?: Record<string, any>;
    };

    try {
      const result = store.update(taskId, fields);
      widget.update();
      pi.events.emit(`tasks:rpc:update:reply:${requestId}`, {
        success: !!result.task,
      });
    } catch (err: any) {
      pi.events.emit(`tasks:rpc:update:reply:${requestId}`, {
        error: err.message,
      });
    }
  }));

  // Broadcast availability AFTER all RPC handlers are registered,
  // so consumers that react to tasks:ready can immediately call any RPC.
  pi.events.emit("tasks:ready", {});

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

  /** One-time orphan reminder built at resume, consumed+cleared by tool_result handler. */
  let pendingOrphanReminder: string | undefined;

  /** Restore widget on session start/resume if there's unfinished work.
   *  On new sessions, auto-clear if all tasks are completed (clean slate).
   *  On resume, always show tasks (user may want to review).
   *  Only runs once — the first caller wins. */
  function showPersistedTasks(isResume = false) {
    if (persistedTasksShown) return;
    persistedTasksShown = true;
    const tasks = store.list();
    if (tasks.length > 0) {
      if (!isResume && tasks.every(t => isTerminalStatus(t.status))) {
        store.clearCompleted();
        if (taskScope === "session") store.deleteFileIfEmpty();
      } else {
        widget.update();
        // Build one-time orphan reminder for in_progress tasks on resume
        if (isResume) {
          const orphanIds = tasks.filter(t => t.status === "in_progress").map(t => `#${t.id}`);
          if (orphanIds.length > 0) {
            pendingOrphanReminder = `<system-reminder>Session resumed. The following tasks were in_progress and may need attention (their agents are no longer running): ${orphanIds.join(", ")}. Consider completing, skipping, or restarting them.</system-reminder>`;
          }
        }
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
  });

  // ── Token usage tracking ──
  // Feed per-turn token counts from assistant messages into the widget.
  pi.on("turn_end", async (event) => {
    const msg = event.message as any;
    if (msg?.role === "assistant" && msg.usage) {
      const totalTokens = (msg.usage.input ?? 0) + (msg.usage.output ?? 0);
      widget.addTokenUsage(msg.usage.input ?? 0, msg.usage.output ?? 0);

      // Best-effort token budget tracking for active tasks
      for (const [taskId, budget] of taskBudgets) {
        if (!budget.tokenBudget) continue;
        budget.tokensUsed += totalTokens;
        widget.setBudget(taskId, {
          tokenBudget: budget.tokenBudget,
          tokensUsed: budget.tokensUsed,
          startedAt: budget.startedAt,
          timeoutMs: budget.timeoutMs,
        });
      }
    }
  });

  // ── System-reminder injection via tool_result event ──
  // Appends a <system-reminder> nudge to non-task tool results when tasks exist
  // but task tools haven't been used recently (mimics Claude Code's behavior).
  pi.on("tool_result", async (event) => {
    // One-time orphaned task notification on resume
    if (pendingOrphanReminder) {
      const reminder = pendingOrphanReminder;
      pendingOrphanReminder = undefined;
      return {
        content: [...event.content, { type: "text" as const, text: reminder }],
      };
    }

    // Task tool usage resets the reminder timer
    if (TASK_TOOL_NAMES.has(event.toolName)) {
      lastTaskToolUseTurn = currentTurn;
      reminderInjectedThisCycle = false;
      return {};
    }

    // Cheap checks first — avoid store.list() disk I/O when possible
    const nudgeInterval = cfg.nudgeInterval ?? REMINDER_INTERVAL;
    if (nudgeInterval === 0) return {}; // nudges disabled
    if (currentTurn - lastTaskToolUseTurn < nudgeInterval) return {};
    if (reminderInjectedThisCycle) return {};

    const tasks = store.list();
    if (tasks.length === 0) return {};

    // Suppress nudges when any task is actively being worked on
    if (tasks.some(t => t.status === "in_progress")) return {};

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
  });

  // session_switch fires on resume (reason: "resume") — reload persisted tasks.
  // Cast: session_switch is a de-facto pi lifecycle event not yet in the public types.
  // TODO: remove cast once pi SDK exports session_switch in ExtensionAPI.on() overloads.
  pi.on("session_switch" as any, async (event: any, ctx: ExtensionContext) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    showPersistedTasks(event?.reason === "resume");
  });

  // Keep latestCtx fresh on every tool execution as well.
  pi.on("tool_execution_start", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    widget.update();
  });

  /** Shared logic for creating a single task (used by TaskCreate and TaskCreateMany).
   *  Returns the created task and any dependency warnings (dangling refs, cycles). */
  function createSingleTask(params: {
    subject: string; description: string; activeForm?: string; agentType?: string;
    metadata?: Record<string, any>; blockedBy?: string[]; blocks?: string[];
    status?: "pending" | "in_progress";
  }): { task: ReturnType<typeof store.create>; warnings: string[] } {
    const meta = params.metadata ?? {};
    if (params.agentType) meta.agentType = params.agentType;
    const task = store.create(
      params.subject, params.description, params.activeForm,
      Object.keys(meta).length > 0 ? meta : undefined,
      params.status ? { status: params.status } : undefined,
    );

    // Wire dependencies if provided
    let warnings: string[] = [];
    const depFields: { addBlocks?: string[]; addBlockedBy?: string[] } = {};
    if (params.blocks?.length) depFields.addBlocks = params.blocks;
    if (params.blockedBy?.length) depFields.addBlockedBy = params.blockedBy;
    if (depFields.addBlocks || depFields.addBlockedBy) {
      const result = store.update(task.id, depFields);
      warnings = result.warnings;
    }

    if (params.status === "in_progress") {
      widget.setActiveTask(task.id);
    }
    return { task, warnings };
  }

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
- Include \`agentType\` (e.g., "general-purpose", "Explore") to mark tasks for subagent execution via TaskExecute

## Subagent Execution

To run a task as a subagent: (1) create the task with \`agentType\` set (e.g., "general-purpose"), then (2) call TaskExecute with the task ID. The agent receives the task description as its prompt and runs in the background. Monitor progress with TaskGet/TaskList.

## Advanced Parameters

- **blockedBy** / **blocks**: Set up dependencies at creation time (avoids a separate TaskUpdate call)
- **status**: Create a task as \`in_progress\` to start working on it immediately (avoids a separate TaskUpdate call)
- **clearCompleted**: Set to true to clear completed/skipped tasks before creating this one`,
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
      blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task (sets up dependencies at creation)" })),
      blocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks (sets up dependencies at creation)" })),
      status: Type.Optional(Type.Unsafe<"pending" | "in_progress">({
        type: "string", enum: ["pending", "in_progress"],
        description: "Initial status — use 'in_progress' to start working immediately",
      })),
      clearCompleted: Type.Optional(Type.Boolean({ description: "Clear completed/skipped tasks before creating this one" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const shouldClear = params.clearCompleted ?? (cfg.autoClearCompleted ?? false);
      if (shouldClear) store.clearCompleted();

      const { task, warnings } = createSingleTask(params);
      widget.update();
      let text = formatTaskDetail(store.get(task.id) ?? task);
      if (warnings.length > 0) text += `\nWarnings: ${warnings.join("; ")}`;
      return Promise.resolve(textResult(text));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 1b: TaskCreateMany
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskCreateMany",
    label: "TaskCreateMany",
    description: `Create multiple tasks in a single call — reduces round-trips when setting up a task list.

## When to Use This Tool

- When you need to create 2 or more tasks at once (e.g., breaking down a plan into steps)
- When tasks have dependencies on each other — blockedBy/blocks references use IDs of tasks created in this same batch
- Replaces the pattern of calling TaskCreate + TaskUpdate multiple times

## Batch Dependency References

Tasks are created in array order with sequential IDs. Use the expected IDs in blockedBy/blocks.
For example, if the next task ID is 5 and you create 3 tasks, they get IDs 5, 6, 7.
Use TaskList first to determine the next available ID if needed.`,
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        subject: Type.String({ description: "A brief title for the task" }),
        description: Type.String({ description: "A detailed description of what needs to be done" }),
        activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
        agentType: Type.Optional(Type.String({ description: "Agent type for subagent execution" })),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata" })),
        blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
        blocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
        status: Type.Optional(Type.Unsafe<"pending" | "in_progress">({
          type: "string", enum: ["pending", "in_progress"],
          description: "Initial status",
        })),
      }), { description: "Array of tasks to create" }),
      clearCompleted: Type.Optional(Type.Boolean({ description: "Clear completed/skipped tasks before creating" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const shouldClear = params.clearCompleted ?? (cfg.autoClearCompleted ?? false);
      if (shouldClear) store.clearCompleted();

      const createdTasks: Array<{ id: string; subject: string }> = [];
      const allWarnings: string[] = [];

      for (const t of params.tasks) {
        const { task, warnings } = createSingleTask(t);
        createdTasks.push({ id: task.id, subject: task.subject });
        allWarnings.push(...warnings);
      }

      widget.update();

      const lines = createdTasks.map(t => `#${t.id}: ${t.subject}`);
      let text = `Created ${createdTasks.length} task(s):\n${lines.join("\n")}`;
      if (allWarnings.length > 0) text += `\nWarnings: ${allWarnings.join("; ")}`;
      return Promise.resolve(textResult(text));
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

      // Sort: pending first (by ID), then in_progress (by ID), then completed/skipped (by ID)
      const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2, skipped: 3 };
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

        // Only show non-resolved blockers
        if (task.blockedBy.length > 0) {
          const openBlockers = task.blockedBy.filter(bid => {
            const blocker = store.get(bid);
            return blocker && !isTerminalStatus(blocker.status);
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
      return Promise.resolve(textResult(formatTaskDetail(task)));
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
      status: Type.Optional(Type.Unsafe<"pending" | "in_progress" | "completed" | "skipped" | "deleted">({
        anyOf: [
          { type: "string", enum: ["pending", "in_progress", "completed", "skipped"] },
          { type: "string", const: "deleted" },
        ],
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
      } else if ((fields.status && isTerminalStatus(fields.status)) || fields.status === "deleted") {
        widget.setActiveTask(taskId, false);
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
        throw new Error(`No running background process for task ${taskId}`);
      }

      store.update(taskId, { status: "completed" });
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
    description: `Execute one or more tasks as subagents. Requires @tintinweb/pi-subagents extension.

## When to Use This Tool

- To start execution of tasks that have \`agentType\` set (created via TaskCreate with agentType parameter)
- Tasks must be \`pending\` with all blockedBy dependencies resolved (\`completed\` or \`skipped\`)
- Each task runs as an independent background subagent

## Workflow

1. Create tasks with \`agentType\` set via TaskCreate (e.g., agentType: "general-purpose")
2. Set up any dependencies via TaskCreate's blockedBy/blocks params or TaskUpdate
3. Call TaskExecute with the task IDs to launch them as background agents
4. Monitor progress with TaskGet/TaskList — status updates to "completed" or reverts to "pending" on failure
5. If auto-cascade is enabled, unblocked dependent tasks with agentType start automatically

## Parameters

- **task_ids**: Array of task IDs to execute
- **additional_context**: Extra context appended to each agent's prompt
- **model**: Model override for agents (e.g., "sonnet", "haiku")
- **max_turns**: Maximum turns per agent
- **token_budget**: Approximate token budget per agent (best-effort tracking)
- **timeout_ms**: Maximum wall-clock time in milliseconds per agent`,
    parameters: Type.Object({
      task_ids: Type.Array(Type.String(), { description: "Task IDs to execute as subagents" }),
      additional_context: Type.Optional(Type.String({ description: "Extra context for agent prompts" })),
      model: Type.Optional(Type.String({ description: "Model override for agents" })),
      max_turns: Type.Optional(Type.Number({ description: "Max turns per agent", minimum: 1 })),
      token_budget: Type.Optional(Type.Number({ description: "Approximate token budget per agent (best-effort)", minimum: 1 })),
      timeout_ms: Type.Optional(Type.Number({ description: "Max wall-clock time in ms per agent", minimum: 1000 })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      if (!subagentsAvailable) {
        return textResult(
          "TaskExecute requires the @tintinweb/pi-subagents extension to be loaded. " +
          "Install and enable it, then try again."
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

        // Check all blockers are resolved — missing blocker = resolved (deleted/cleared = done)
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = store.get(bid);
          return blocker && !isTerminalStatus(blocker.status);
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
            ...(params.model && { model: params.model }),
          }, signal ?? undefined);
          agentTaskMap.set(agentId, taskId);
          store.update(taskId, { owner: agentId, metadata: { ...task.metadata, agentId } });
          widget.setActiveTask(taskId);
          taskCascadeConfigs.set(taskId, {
            additionalContext: params.additional_context,
            model: params.model,
            maxTurns: params.max_turns,
          });

          // Set up budget/timeout tracking
          if (params.token_budget || params.timeout_ms) {
            const budget: TaskBudget = {
              startedAt: Date.now(),
              tokenBudget: params.token_budget,
              tokensUsed: 0,
              timeoutMs: params.timeout_ms,
            };
            if (params.timeout_ms) {
              budget.timer = setTimeout(() => {
                // Find and remove the agent mapping; capture the agent ID for stop RPC
                let timedOutAgentId: string | undefined;
                for (const [aid, tid] of agentTaskMap) {
                  if (tid === taskId) { timedOutAgentId = aid; agentTaskMap.delete(aid); break; }
                }
                taskCascadeConfigs.delete(taskId);
                // Auto-complete on timeout
                store.update(taskId, {
                  status: "completed",
                  metadata: { ...store.get(taskId)?.metadata, timedOut: true },
                });
                widget.setActiveTask(taskId, false);
                clearTaskBudget(taskId);
                widget.update();
                // Best-effort: request the subagent extension to stop the agent.
                // pi-subagents may or may not handle this channel yet.
                if (timedOutAgentId) {
                  pi.events.emit("subagents:rpc:stop", { agentId: timedOutAgentId });
                }
              }, params.timeout_ms);
            }
            taskBudgets.set(taskId, budget);
            widget.setBudget(taskId, {
              tokenBudget: params.token_budget,
              tokensUsed: 0,
              startedAt: budget.startedAt,
              timeoutMs: params.timeout_ms,
            });
          }

          launched.push(`#${taskId} → agent ${agentId}`);
        } catch (err: any) {
          store.update(taskId, { status: "pending" });
          results.push(`#${taskId}: spawn failed — ${err.message}`);
        }
      }

      widget.update();

      const lines: string[] = [];
      if (launched.length > 0) lines.push(`Launched ${launched.length} agent(s):\n${launched.join("\n")}`);
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
        const terminalCount = tasks.filter(t => isTerminalStatus(t.status)).length;

        const choices: string[] = [
          `View all tasks (${taskCount})`,
          "Create task",
        ];
        if (terminalCount > 0) choices.push(`Clear completed (${terminalCount})`);
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
            case "skipped": return "⊘";
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
        if (task.status === "pending" || task.status === "in_progress") {
          actions.push("⊘ Skip");
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
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        } else if (action === "⊘ Skip") {
          store.update(taskId, { status: "skipped" });
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
        openSettingsMenu(ui, cfg, mainMenu);

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

  // ── Dispose: clean up event bus listeners, timers, and widget ──
  return {
    dispose() {
      for (const unsub of eventUnsubs) unsub();
      eventUnsubs.length = 0;
      for (const cleanup of activeSpawnCleanups) cleanup();
      activeSpawnCleanups.clear();
      for (const [taskId] of taskBudgets) clearTaskBudget(taskId);
      taskBudgets.clear();
      unsubPing();
      unsubReady();
      tracker.dispose();
      widget.dispose();
    },
  };
}
