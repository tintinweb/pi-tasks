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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AutoClearManager } from "./auto-clear.js";
import { ProcessTracker } from "./process-tracker.js";
import {
  buildTaskSessionStateDetails,
  reconstructSessionStateStore,
  SessionStateTaskStore,
  TASKS_SESSION_STATE_TYPE,
} from "./session-state-store.js";
import { resolveTaskStorePath } from "./storage-paths.js";
import { TaskStore, type TaskStoreLike } from "./task-store.js";
import { loadTasksConfig } from "./tasks-config.js";
import { isTerminalStatus, type Task, type TaskBudget, type TaskStatus } from "./types.js";
import { openSettingsMenu } from "./ui/settings-menu.js";
import { TaskWidget, type UICtx } from "./ui/task-widget.js";

// ---- Debug ----

const DEBUG = !!process.env.PI_TASKS_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-tasks]", ...args);
}

// ---- Helpers ----

function textResult(msg: string, details?: any) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

function formatTaskDetail(task: { id: string; subject: string; description: string; status: string; owner?: string; blockedBy: string[]; blocks: string[]; metadata?: Record<string, any> }): string {
  const lines: string[] = [
    `Task #${task.id}: ${task.subject}`,
    `Status: ${task.status}`,
  ];
  if (task.owner) lines.push(`Owner: ${task.owner}`);
  const desc = task.description.replace(/\\n/g, "\n");
  lines.push(`Description: ${desc}`);
  if (task.blockedBy.length > 0) lines.push(`Blocked by: ${task.blockedBy.map(id => "#" + id).join(", ")}`);
  if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.map(id => "#" + id).join(", ")}`);
  if (task.metadata && Object.keys(task.metadata).length > 0) {
    lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);
  }
  return lines.join("\n");
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
  try {
    const gitInstallPath = join(homedir(), ".pi", "agent", "git", "pi-tasks");
    const hasGitInstall = existsSync(gitInstallPath);
    const isNpmGlobal = import.meta.url?.includes("node_modules");
    if (hasGitInstall && isNpmGlobal) {
      console.warn("[pi-tasks] Warning: detected both git and npm global installations. This may cause conflicts.");
    }
  } catch { /* ignore */ }

  // Initialize store and config
  const cfg = loadTasksConfig();
  const piTasks = process.env.PI_TASKS;
  let currentPersistenceBackend = cfg.persistenceBackend ?? "session_state";
  let currentTaskScope = cfg.taskScope ?? "session";
  let currentTaskStorageLocation = cfg.taskStorageLocation ?? "local";

  function getPersistenceBackend() {
    if (piTasks !== undefined) return "file";
    return currentPersistenceBackend;
  }

  function isSessionStateBackend() {
    return getPersistenceBackend() === "session_state";
  }

  function getTaskScope() {
    return currentTaskScope;
  }

  function getTaskStorageLocation() {
    return currentTaskStorageLocation;
  }

  function applyConfiguredStorageSettings() {
    currentPersistenceBackend = cfg.persistenceBackend ?? "session_state";
    currentTaskScope = cfg.taskScope ?? "session";
    currentTaskStorageLocation = cfg.taskStorageLocation ?? "local";
  }

  /** Resolve the task store path from env/config (without session ID). */
  function resolveStorePath(sessionId?: string): string | undefined {
    if (isSessionStateBackend()) return undefined;
    return resolveTaskStorePath({
      cwd: process.cwd(),
      taskScope: getTaskScope(),
      storageLocation: getTaskStorageLocation(),
      sessionId,
      piTasks,
    });
  }

  function createStore(sessionId?: string): TaskStoreLike {
    if (isSessionStateBackend()) return new SessionStateTaskStore();
    return new TaskStore(resolveStorePath(sessionId));
  }

  function snapshotSessionState(ctx?: ExtensionContext) {
    if (!isSessionStateBackend()) return;
    const targetCtx = ctx ?? latestCtx;
    if (!targetCtx) return;
    pi.appendEntry(TASKS_SESSION_STATE_TYPE, buildTaskSessionStateDetails(store));
  }

  function reconstructStoreFromSession(ctx: ExtensionContext) {
    if (!isSessionStateBackend()) return;
    reconstructSessionStateStore(ctx, store);
  }

  // For project scope (or env override), create store immediately.
  // For session scope, start with in-memory and upgrade once we have the session ID.
  let store: TaskStoreLike = createStore();
  const tracker = new ProcessTracker();
  const widget = new TaskWidget(store);

  // ── Subagent integration state ──
  /** Latest ExtensionContext — refreshed on every tool execution so cascade always has a valid one. */
  let latestCtx: ExtensionContext | undefined;
  /** Per-task cascade config — set by TaskExecute, consumed by completion listener. */
  const taskCascadeConfigs = new Map<string, { additionalContext?: string; model?: string; maxTurns?: number }>();
  /** Maps agent IDs to task IDs for O(1) completion lookup. */
  const agentTaskMap = new Map<string, string>();
  const taskBudgets = new Map<string, TaskBudget>();

  function clearTaskBudget(taskId: string) {
    const budget = taskBudgets.get(taskId);
    if (budget?.timer) clearTimeout(budget.timer);
    taskBudgets.delete(taskId);
    widget.clearBudget(taskId);
  }

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

  const activeSpawnCleanups = new Set<() => void>();

  /** Spawn a subagent via pi.events RPC (requires @tintinweb/pi-subagents extension). */
  function spawnSubagent(type: string, prompt: string, options?: any, signal?: AbortSignal): Promise<string> {
    debug("spawn:call", { type, options: { ...options, prompt: undefined } });
    const requestId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { cleanup(); reject(new Error("subagents:rpc:spawn timeout")); }, 30_000);
      const unsub = pi.events.on(`subagents:rpc:spawn:reply:${requestId}`, (raw: unknown) => {
        if (settled) return;
        cleanup();
        const reply = raw as RpcReply<{ id: string }>;
        if (reply.success && reply.data?.id) resolve(reply.data.id);
        else reject(new Error(reply.success ? "subagents:rpc:spawn failed" : reply.error));
      });

      function cleanup() {
        if (settled) return;
        settled = true;
        unsub();
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        activeSpawnCleanups.delete(cleanup);
      }

      function onAbort() {
        cleanup();
        reject(new DOMException("The operation was aborted", "AbortError"));
      }

      activeSpawnCleanups.add(cleanup);
      if (signal?.aborted) {
        cleanup();
        reject(new DOMException("The operation was aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      pi.events.emit("subagents:rpc:spawn", { requestId, type, prompt, options });
    }).then(id => { debug("spawn:ok", { id }); return id; });
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
  const unsubReady = pi.events.on("subagents:ready", () => checkSubagentsVersion());

  /** Build a prompt for a task being executed by a subagent. */
  function buildTaskPrompt(task: { id: string; subject: string; description: string }, additionalContext?: string): string {
    let prompt = `You are executing task #${task.id}: "${task.subject}"\n\n${task.description}`;
    if (additionalContext) prompt += `\n\n${additionalContext}`;
    prompt += `\n\nComplete this task fully. Do not attempt to manage tasks yourself.`;
    return prompt;
  }

  const autoClear = new AutoClearManager(() => store, () => cfg.autoClearCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY);

  const eventUnsubs: Array<() => void> = [];

  // ── Subagent completion listener ──
  // Listens for subagent lifecycle events to update task status and optionally cascade.

  function makeToolResultDetails() {
    return isSessionStateBackend() ? buildTaskSessionStateDetails(store) : undefined;
  }

  function persistSessionStateAndUpdateWidget(ctx?: ExtensionContext) {
    snapshotSessionState(ctx);
    widget.update();
  }

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

    const cascadeConfig = taskCascadeConfigs.get(taskId);
    taskCascadeConfigs.delete(taskId);
    if ((cfg.autoCascade ?? false) && cascadeConfig && latestCtx) {
      const unblocked = store.list().filter(t =>
        t.status === "pending" &&
        t.metadata?.agentType &&
        t.blockedBy.includes(task.id) &&
        t.blockedBy.every(depId => {
          const blocker = store.get(depId);
          return !blocker || isTerminalStatus(blocker.status);
        })
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
          taskCascadeConfigs.set(next.id, cascadeConfig);
        } catch (err: any) {
          store.update(next.id, { status: "pending", metadata: { ...next.metadata, lastError: err.message } });
        }
      }
    }
    autoClear.trackCompletion(task.id, currentTurn);
    persistSessionStateAndUpdateWidget();
  }));

  // Failure → store error, revert to pending, don't cascade (branch stops)
  // Intentional stop (status === "stopped") → mark completed, preserve partial result
  eventUnsubs.push(pi.events.on("subagents:failed", (data) => {
    const { id, error, result, status } = data as { id: string; error?: string; result?: string; status: string };
    const taskId = agentTaskMap.get(id);
    if (!taskId) return;
    agentTaskMap.delete(id);
    const task = store.get(taskId);
    if (!task) return;

    if (status === "stopped") {
      store.update(task.id, { status: "completed", metadata: { ...task.metadata, result: result || task.metadata?.result } });
      autoClear.trackCompletion(task.id, currentTurn);
    } else {
      store.update(task.id, { status: "pending", metadata: { ...task.metadata, lastError: error || status } });
      autoClear.resetBatchCountdown();
    }
    widget.setActiveTask(task.id, false);
    clearTaskBudget(taskId);
    taskCascadeConfigs.delete(taskId);
    persistSessionStateAndUpdateWidget();
  }));

  eventUnsubs.push(pi.events.on("tasks:rpc:ping", (payload: unknown) => {
    const { requestId } = payload as { requestId: string };
    pi.events.emit(`tasks:rpc:ping:reply:${requestId}`, {});
  }));

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
      persistSessionStateAndUpdateWidget();
      pi.events.emit(`tasks:rpc:createMany:reply:${requestId}`, {
        ids: created.map(c => c.id),
        ...(rpcWarnings.length > 0 && { warnings: rpcWarnings }),
      });
    } catch (err: any) {
      pi.events.emit(`tasks:rpc:createMany:reply:${requestId}`, {
        error: err.message,
        partialIds: created.map(c => c.id),
      });
    }
  }));

  eventUnsubs.push(pi.events.on("tasks:rpc:update", (payload: unknown) => {
    const p = payload as Record<string, unknown> | undefined;
    if (!p || typeof p.requestId !== "string") return;
    const requestId = p.requestId;

    const extractUpdateFields = (raw: Record<string, unknown>) => {
      if (raw.fields && typeof raw.fields === "object") {
        return raw.fields as {
          status?: TaskStatus | "deleted";
          subject?: string;
          description?: string;
          activeForm?: string;
          owner?: string;
          metadata?: Record<string, any>;
          addBlocks?: string[];
          addBlockedBy?: string[];
        };
      }

      const { requestId: _requestId, taskId: _taskId, tasks: _tasks, fields: _fields, ...directFields } = raw;
      return directFields as {
        status?: TaskStatus | "deleted";
        subject?: string;
        description?: string;
        activeForm?: string;
        owner?: string;
        metadata?: Record<string, any>;
        addBlocks?: string[];
        addBlockedBy?: string[];
      };
    };

    try {
      if (Array.isArray(p.tasks)) {
        const updatedIds: string[] = [];
        const missingIds: string[] = [];
        const rpcWarnings: string[] = [];

        for (const rawTask of p.tasks as Array<Record<string, unknown>>) {
          if (!rawTask || typeof rawTask.taskId !== "string") {
            throw new Error("taskId is required for each batch update");
          }

          const result = updateSingleTask({
            taskId: rawTask.taskId,
            ...extractUpdateFields(rawTask),
          });

          if (result.changedFields.length === 0 && !result.task) missingIds.push(rawTask.taskId);
          else updatedIds.push(rawTask.taskId);
          rpcWarnings.push(...result.warnings);
        }

        persistSessionStateAndUpdateWidget();
        pi.events.emit(`tasks:rpc:update:reply:${requestId}`, {
          success: missingIds.length === 0,
          ids: updatedIds,
          ...(missingIds.length > 0 && { missingIds }),
          ...(rpcWarnings.length > 0 && { warnings: rpcWarnings }),
        });
        return;
      }

      if (typeof p.taskId !== "string") return;
      const result = updateSingleTask({
        taskId: p.taskId,
        ...extractUpdateFields(p),
      });

      persistSessionStateAndUpdateWidget();
      pi.events.emit(`tasks:rpc:update:reply:${requestId}`, {
        success: !!result.task,
        ...(result.warnings.length > 0 && { warnings: result.warnings }),
      });
    } catch (err: any) {
      pi.events.emit(`tasks:rpc:update:reply:${requestId}`, { error: err.message });
    }
  }));

  pi.events.emit("tasks:ready", {});

  // ── Session-scoped store upgrade ──
  // For session scope, the store starts in-memory (no session ID at init time).
  // Upgrade to file-backed on first context arrival (turn_start, before_agent_start,
  // or tool_execution_start — whichever fires first).
  let storeUpgraded = false;
  let persistedTasksShown = false;
  function upgradeStoreIfNeeded(ctx: ExtensionContext) {
    if (storeUpgraded) return;
    if (isSessionStateBackend()) {
      store = createStore();
      reconstructStoreFromSession(ctx);
      widget.setStore(store);
      storeUpgraded = true;
      return;
    }
    if (getTaskScope() === "session" && !piTasks) {
      const sessionId = ctx.sessionManager.getSessionId();
      store = createStore(sessionId);
      widget.setStore(store);
    }
    storeUpgraded = true;
  }

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
        if (!isSessionStateBackend() && getTaskScope() === "session") store.deleteFileIfEmpty();
        persistSessionStateAndUpdateWidget();
      } else {
        widget.update();
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
    if (autoClear.onTurnStart(currentTurn)) persistSessionStateAndUpdateWidget(ctx);
  });

  // ── Token usage tracking ──
  // Feed per-turn token counts from assistant messages into the widget.
  pi.on("turn_end", async (event) => {
    const msg = event.message as any;
    if (msg?.role === "assistant" && msg.usage) {
      const input = msg.usage.input ?? 0;
      const output = msg.usage.output ?? 0;
      const totalTokens = input + output;
      widget.addTokenUsage(input, output);
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
    if (nudgeInterval === 0) return {};
    if (currentTurn - lastTaskToolUseTurn < nudgeInterval) return {};
    if (reminderInjectedThisCycle) return {};

    const tasks = store.list();
    if (tasks.length === 0) return {};
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
    if (pendingWarning) {
      ctx.ui.notify(pendingWarning, "warning");
      pendingWarning = undefined;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    applyConfiguredStorageSettings();
    storeUpgraded = false;
    persistedTasksShown = false;
    widget.resetActivity();
    upgradeStoreIfNeeded(ctx);
    showPersistedTasks();
  });

  pi.on("session_fork", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    storeUpgraded = false;
    persistedTasksShown = false;
    widget.resetActivity();
    upgradeStoreIfNeeded(ctx);
    showPersistedTasks(true);
  });

  pi.on("session_tree", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    storeUpgraded = false;
    persistedTasksShown = false;
    widget.resetActivity();
    upgradeStoreIfNeeded(ctx);
    showPersistedTasks(true);
  });

  // session_switch fires on /new (reason: "new") and /resume (reason: "resume").
  // On /new: reset all session-scoped state so the store switches to the new session file.
  // On resume: reload persisted tasks from the existing session file.
  pi.on("session_switch" as any, async (event: any, ctx: ExtensionContext) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);

    const isResume = event?.reason === "resume";
    applyConfiguredStorageSettings();

    // Reset session-scoped state for both /new and /resume
    storeUpgraded = false;
    persistedTasksShown = false;
    currentTurn = 0;
    lastTaskToolUseTurn = 0;
    reminderInjectedThisCycle = false;
    autoClear.reset();
    widget.resetActivity();

    // Memory mode has no file-backed store to switch — clear explicitly on /new
    if (!isSessionStateBackend() && !isResume && getTaskScope() === "memory") {
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

  const taskItemSchema = Type.Object({
    subject: Type.String({ description: "A brief title for the task" }),
    description: Type.String({ description: "A detailed description of what needs to be done" }),
    activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress (e.g., 'Running tests')" })),
    agentType: Type.Optional(Type.String({ description: "Agent type for subagent execution (e.g., 'general-purpose', 'Explore'). Tasks with agentType can be started via TaskExecute." })),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
    blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
    blocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
    status: Type.Optional(Type.Unsafe<"pending" | "in_progress">({
      type: "string", enum: ["pending", "in_progress"],
      description: "Initial status",
    })),
  });

  function createSingleTask(params: {
    subject: string;
    description: string;
    activeForm?: string;
    agentType?: string;
    metadata?: Record<string, any>;
    blockedBy?: string[];
    blocks?: string[];
    status?: "pending" | "in_progress";
  }) {
    const meta = params.metadata ?? {};
    if (params.agentType) meta.agentType = params.agentType;
    const task = store.create(
      params.subject,
      params.description,
      params.activeForm,
      Object.keys(meta).length > 0 ? meta : undefined,
      params.status ? { status: params.status } : undefined,
    );

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

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Use this tool to create one or more structured tasks for the current coding session.

Single mode: pass subject and description directly.
Batch mode: pass a tasks array.

Use this tool proactively for complex multi-step work. Mark tasks in_progress before starting, completed when done. You can also set dependencies at creation time with blockedBy/blocks.` ,
    promptGuidelines: [
      "When working on complex multi-step tasks, use TaskCreate to track progress and TaskUpdate to update status.",
      "Mark tasks as in_progress before starting work and completed when done.",
      "Use TaskList to check for available work after completing a task.",
    ],
    parameters: Type.Object({
      subject: Type.Optional(Type.String({ description: "A brief title for the task" })),
      description: Type.Optional(Type.String({ description: "A detailed description of what needs to be done" })),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress (e.g., 'Running tests')" })),
      agentType: Type.Optional(Type.String({ description: "Agent type for subagent execution (e.g., 'general-purpose', 'Explore'). Tasks with agentType can be started via TaskExecute." })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
      blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
      blocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
      status: Type.Optional(Type.Unsafe<"pending" | "in_progress">({
        type: "string", enum: ["pending", "in_progress"],
        description: "Initial status",
      })),
      clearCompleted: Type.Optional(Type.Boolean({ description: "Clear completed/skipped tasks before creating" })),
      tasks: Type.Optional(Type.Array(taskItemSchema, { description: "Batch create tasks" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      autoClear.resetBatchCountdown();
      const shouldClear = params.clearCompleted === true;
      if (shouldClear) store.clearCompleted();

      if (params.tasks) {
        if (params.tasks.length === 0) {
          return Promise.resolve(textResult("Created 0 task(s).", makeToolResultDetails()));
        }
        const createdTasks: Array<{ id: string; subject: string }> = [];
        const allWarnings: string[] = [];
        for (const t of params.tasks) {
          const { task, warnings } = createSingleTask(t);
          createdTasks.push({ id: task.id, subject: task.subject });
          allWarnings.push(...warnings);
        }
        widget.update();
        let text = `Created ${createdTasks.length} task(s):\n${createdTasks.map(t => `#${t.id}: ${t.subject}`).join("\n")}`;
        if (allWarnings.length > 0) text += `\nWarnings: ${allWarnings.join("; ")}`;
        return Promise.resolve(textResult(text, makeToolResultDetails()));
      }

      if (!params.subject || !params.description) {
        return Promise.resolve(textResult("Error: subject and description are required (or provide a tasks array for batch mode)", makeToolResultDetails()));
      }

      const { task, warnings } = createSingleTask(params as Parameters<typeof createSingleTask>[0]);
      widget.update();
      let text = formatTaskDetail(store.get(task.id) ?? task);
      if (warnings.length > 0) text += `\nWarnings: ${warnings.join("; ")}`;
      return Promise.resolve(textResult(text, makeToolResultDetails()));
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
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks found", makeToolResultDetails()));

      // Sort: pending first, then in_progress, then completed, then skipped
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

      return Promise.resolve(textResult(lines.join("\n"), makeToolResultDetails()));
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
      if (!task) return Promise.resolve(textResult(`Task not found`, makeToolResultDetails()));

      return Promise.resolve(textResult(formatTaskDetail(task), makeToolResultDetails()));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 4: TaskUpdate
  // ──────────────────────────────────────────────────

  const taskUpdateFieldSchema = {
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
  };

  const taskUpdateItemSchema = Type.Object({
    taskId: Type.String({ description: "The ID of the task to update" }),
    ...taskUpdateFieldSchema,
  });

  type TaskUpdateFields = Parameters<TaskStoreLike["update"]>[1];
  type TaskUpdateResult = ReturnType<TaskStoreLike["update"]>;

  function cloneTask(task: Task | undefined): Task | undefined {
    if (!task) return undefined;
    return {
      ...task,
      metadata: { ...task.metadata },
      blocks: [...task.blocks],
      blockedBy: [...task.blockedBy],
    };
  }

  function formatTaskIdList(ids: string[] | undefined) {
    return ids && ids.length > 0 ? `[${ids.map(id => `#${id}`).join(", ")}]` : "[]";
  }

  function applyTaskUpdateEffects(taskId: string, fields: TaskUpdateFields) {
    if (fields.status === "in_progress") {
      widget.setActiveTask(taskId);
      autoClear.resetBatchCountdown();
    } else if (fields.status === "pending") {
      autoClear.resetBatchCountdown();
    } else if ((fields.status && isTerminalStatus(fields.status)) || fields.status === "deleted") {
      widget.setActiveTask(taskId, false);
      if (fields.status === "completed") autoClear.trackCompletion(taskId, currentTurn);
    }
  }

  function updateSingleTask(params: { taskId: string } & TaskUpdateFields) {
    const { taskId, ...rest } = params;
    const fields: TaskUpdateFields = rest;
    const previousTask = cloneTask(store.get(taskId));
    const result = store.update(taskId, fields);
    const task = cloneTask(result.task ?? store.get(taskId));

    if (result.changedFields.length > 0 || result.task) {
      applyTaskUpdateEffects(taskId, fields);
    }

    return { ...result, taskId, previousTask, task };
  }

  function formatTaskFieldUpdate(
    field: string,
    previousTask: Task | undefined,
    task: Task | undefined,
  ) {
    switch (field) {
      case "status":
        return `status: ${previousTask?.status ?? "missing"} → ${task?.status ?? "deleted"}`;
      case "subject":
        return `subject: ${JSON.stringify(previousTask?.subject ?? "")} → ${JSON.stringify(task?.subject ?? "")}`;
      case "description":
        return "description updated";
      case "activeForm":
        return `activeForm: ${previousTask?.activeForm ?? "none"} → ${task?.activeForm ?? "none"}`;
      case "owner":
        return `owner: ${previousTask?.owner ?? "none"} → ${task?.owner ?? "none"}`;
      case "metadata":
        return "metadata updated";
      case "blocks":
        return `blocks: ${formatTaskIdList(previousTask?.blocks)} → ${formatTaskIdList(task?.blocks)}`;
      case "blockedBy":
        return `blockedBy: ${formatTaskIdList(previousTask?.blockedBy)} → ${formatTaskIdList(task?.blockedBy)}`;
      case "deleted":
        return `status: ${previousTask?.status ?? "missing"} → deleted`;
      default:
        return field;
    }
  }

  function formatTaskUpdateResult(
    taskId: string,
    previousTask: Task | undefined,
    task: TaskUpdateResult["task"],
    changedFields: string[],
    warnings: string[],
  ) {
    if (changedFields.length === 0 && !task) {
      return `Task #${taskId} not found`;
    }

    const details = changedFields.map(field => formatTaskFieldUpdate(field, previousTask, task));
    let msg = changedFields.length === 1 && changedFields[0] === "deleted"
      ? `Deleted task #${taskId}`
      : `Updated task #${taskId}`;
    if (details.length > 0) {
      msg += ` ${details.join("; ")}`;
    }
    if (warnings.length > 0) {
      msg += ` (warning: ${warnings.join("; ")})`;
    }
    return msg;
  }

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Use this tool to update one or more tasks in the task list.

Single mode: pass taskId directly.
Batch mode: pass a tasks array.

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
\`\`\`

Batch update several tasks at once:
\`\`\`json
{"tasks": [{"taskId": "1", "status": "completed"}, {"taskId": "2", "owner": "my-name"}]}
\`\`\``,
    parameters: Type.Object({
      taskId: Type.Optional(Type.String({ description: "The ID of the task to update" })),
      ...taskUpdateFieldSchema,
      tasks: Type.Optional(Type.Array(taskUpdateItemSchema, { description: "Batch update tasks" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.tasks) {
        if (params.tasks.length === 0) {
          return Promise.resolve(textResult("Updated 0 task(s).", makeToolResultDetails()));
        }

        const messages = params.tasks.map(taskParams => {
          const result = updateSingleTask(taskParams);
          return formatTaskUpdateResult(result.taskId, result.previousTask, result.task, result.changedFields, result.warnings);
        });

        widget.update();
        return Promise.resolve(textResult(`Processed ${params.tasks.length} task(s):\n${messages.join("\n")}`, makeToolResultDetails()));
      }

      if (!params.taskId) {
        return Promise.resolve(textResult("Error: taskId is required (or provide a tasks array for batch mode)", makeToolResultDetails()));
      }

      const result = updateSingleTask(params as Parameters<typeof updateSingleTask>[0]);
      widget.update();
      return Promise.resolve(textResult(
        formatTaskUpdateResult(result.taskId, result.previousTask, result.task, result.changedFields, result.warnings),
        makeToolResultDetails(),
      ));
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
          return textResult(`Task #${task_id} [${updated.status}] — subagent ${task.metadata.agentId}`, makeToolResultDetails());
        }
        throw new Error(`No background process for task ${task_id}`);
      }

      if (block && processOutput.status === "running") {
        const result = await tracker.waitForCompletion(task_id, timeout ?? 30000, signal ?? undefined);
        if (result) {
          return textResult(
            `Task #${task_id} (${result.status})${result.exitCode !== undefined ? ` exit code: ${result.exitCode}` : ""}\n\n${result.output}`,
            makeToolResultDetails(),
          );
        }
      }

      return textResult(
        `Task #${task_id} (${processOutput.status})${processOutput.exitCode !== undefined ? ` exit code: ${processOutput.exitCode}` : ""}\n\n${processOutput.output}`,
        makeToolResultDetails(),
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
          store.update(resolvedId, { status: "completed" });
          autoClear.trackCompletion(resolvedId, currentTurn);
          await stopSubagent(task.metadata.agentId);
          widget.setActiveTask(resolvedId, false);
          persistSessionStateAndUpdateWidget();
          return textResult(`Task #${resolvedId} stopped successfully`, makeToolResultDetails());
        }
        throw new Error(`No running background process for task ${taskId}`);
      }

      store.update(taskId, { status: "completed" });
      autoClear.trackCompletion(taskId, currentTurn);
      widget.setActiveTask(taskId, false);
      persistSessionStateAndUpdateWidget();
      return textResult(`Task #${taskId} stopped successfully`, makeToolResultDetails());
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
- Tasks must be \`pending\` with all blockedBy dependencies resolved (\`completed\` or \`skipped\`)
- Each task runs as an independent background subagent

## Workflow

1. Create tasks with \`agentType\` set
2. Add dependencies if needed
3. Call TaskExecute with task IDs
4. Monitor with TaskGet/TaskList

## Parameters

- **task_ids**: Array of task IDs to execute
- **additional_context**: Extra context appended to each agent's prompt
- **model**: Model override for agents (e.g., "sonnet", "haiku")
- **max_turns**: Maximum turns per agent
- **token_budget**: Approximate token budget per agent
- **timeout_ms**: Maximum wall-clock time in milliseconds per agent`,
    promptGuidelines: [
      "Never use the Agent tool for tasks launched via TaskExecute — agents are already running.",
    ],
    parameters: Type.Object({
      task_ids: Type.Array(Type.String(), { description: "Task IDs to execute as subagents" }),
      additional_context: Type.Optional(Type.String({ description: "Extra context for agent prompts" })),
      model: Type.Optional(Type.String({ description: "Model override for agents" })),
      max_turns: Type.Optional(Type.Number({ description: "Max turns per agent", minimum: 1 })),
      token_budget: Type.Optional(Type.Number({ description: "Approximate token budget per agent", minimum: 1 })),
      timeout_ms: Type.Optional(Type.Number({ description: "Max wall-clock time in ms per agent", minimum: 1000 })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      if (!subagentsAvailable) {
        return textResult(
          "Subagent execution is currently unavailable. " +
          "Ensure the @tintinweb/pi-subagents extension is loaded and try again.",
          makeToolResultDetails(),
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

        // Check all blockers are resolved
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

          if (params.token_budget || params.timeout_ms) {
            const budget: TaskBudget = {
              startedAt: Date.now(),
              tokenBudget: params.token_budget,
              tokensUsed: 0,
              timeoutMs: params.timeout_ms,
            };
            if (params.timeout_ms) {
              budget.timer = setTimeout(() => {
                let timedOutAgentId: string | undefined;
                for (const [aid, tid] of agentTaskMap) {
                  if (tid === taskId) { timedOutAgentId = aid; agentTaskMap.delete(aid); break; }
                }
                taskCascadeConfigs.delete(taskId);
                store.update(taskId, {
                  status: "completed",
                  metadata: { ...store.get(taskId)?.metadata, timedOut: true },
                });
                widget.setActiveTask(taskId, false);
                clearTaskBudget(taskId);
                persistSessionStateAndUpdateWidget();
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
          debug(`spawn:error task=#${taskId}`, err);
          store.update(taskId, { status: "pending" });
          results.push(`#${taskId}: spawn failed — ${err.message}`);
        }
      }

      persistSessionStateAndUpdateWidget();

      const lines: string[] = [];
      if (launched.length > 0) {
        const backendNote = isSessionStateBackend()
          ? " Session-state persistence tracks task metadata/status across branches, but live process output remains available only in the current runtime."
          : "";
        lines.push(
          `Launched ${launched.length} agent(s):\n${launched.join("\n")}\n` +
          `Use TaskOutput to check progress. Do not spawn additional agents for these tasks.${backendNote}`
        );
      }
      if (results.length > 0) lines.push(`Skipped:\n${results.join("\n")}`);
      if (lines.length === 0) lines.push("No tasks to execute.");

      return textResult(lines.join("\n\n"), makeToolResultDetails());
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
          if (!isSessionStateBackend() && getTaskScope() === "session") store.deleteFileIfEmpty();
          persistSessionStateAndUpdateWidget(ctx);
          await mainMenu();
        } else if (choice.startsWith("Clear all")) {
          store.clearAll();
          if (!isSessionStateBackend() && getTaskScope() === "session") store.deleteFileIfEmpty();
          persistSessionStateAndUpdateWidget(ctx);
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
          persistSessionStateAndUpdateWidget(ctx);
          return viewTasks();
        } else if (action === "✓ Complete") {
          store.update(taskId, { status: "completed" });
          autoClear.trackCompletion(taskId, currentTurn);
          widget.setActiveTask(taskId, false);
          persistSessionStateAndUpdateWidget(ctx);
          return viewTasks();
        } else if (action === "⊘ Skip") {
          store.update(taskId, { status: "skipped" });
          widget.setActiveTask(taskId, false);
          persistSessionStateAndUpdateWidget(ctx);
          return viewTasks();
        } else if (action === "✗ Delete") {
          store.update(taskId, { status: "deleted" });
          widget.setActiveTask(taskId, false);
          persistSessionStateAndUpdateWidget(ctx);
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
        persistSessionStateAndUpdateWidget(ctx);
        return mainMenu();
      };

      await mainMenu();
    },
  });

  return {
    dispose() {
      for (const unsub of eventUnsubs) unsub();
      eventUnsubs.length = 0;
      for (const cleanup of activeSpawnCleanups) cleanup();
      activeSpawnCleanups.clear();
      for (const [taskId] of taskBudgets) clearTaskBudget(taskId);
      taskBudgets.clear();
      unsubReady();
      tracker.dispose();
      widget.dispose();
    },
  };
}
