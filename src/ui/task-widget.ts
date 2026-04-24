/**
 * task-widget.ts — Persistent widget showing task list with status icons and progress.
 *
 * Display style matches Claude Code's task list:
 *   ✔ completed tasks (strikethrough + dim)
 *   ◼ in_progress tasks
 *   ◻ pending tasks
 *   ⊘ skipped tasks (dim)
 *   ✳/✽ actively executing task (star spinner with activeForm text)
 */

import { truncateToWidth } from "@mariozechner/pi-tui";
import type { TaskStoreLike } from "../task-store.js";
import { isTerminalStatus } from "../types.js";

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Star spinner frames for animated active task indicator (matches Claude Code). */
const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];

const MAX_VISIBLE_TASKS = 10;

/** Per-task runtime metrics (elapsed time, token usage). */
export interface TaskMetrics {
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
}

/** Per-task budget info from TaskExecute. */
export interface TaskBudgetInfo {
  tokenBudget?: number;
  tokensUsed: number;
  startedAt: number;
  timeoutMs?: number;
}

/** Format milliseconds as a human-readable duration (e.g., "2m 49s", "1h 3m"). */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** Format token count with k suffix (e.g., "4.1k", "850"). */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

// ---- Widget ----

export class TaskWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** IDs of tasks currently being actively executed (show spinner). */
  private activeTaskIds = new Set<string>();
  /** Per-task runtime metrics keyed by task ID. */
  private metrics = new Map<string, TaskMetrics>();
  /** Per-task budget info keyed by task ID. */
  private budgets = new Map<string, TaskBudgetInfo>();
  /** Cached TUI instance for requestRender() calls. */
  private tui: any | undefined;
  /** Whether the widget callback is currently registered. */
  private widgetRegistered = false;
  /** Cached task list — refreshed by update(), used by renderWidget(). */
  private cachedTasks: import("../types.js").Task[] = [];

  constructor(private store: TaskStoreLike) {}

  setStore(store: TaskStoreLike) {
    this.store = store;
  }

  resetActivity() {
    this.activeTaskIds.clear();
    this.metrics.clear();
    this.budgets.clear();
  }

  setUICtx(ctx: UICtx) {
    this.uiCtx = ctx;
  }

  /** Add or remove a task from the active spinner set. */
  setActiveTask(taskId: string | undefined, active = true) {
    if (taskId && active) {
      this.activeTaskIds.add(taskId);
      if (!this.metrics.has(taskId)) {
        this.metrics.set(taskId, { startedAt: Date.now(), inputTokens: 0, outputTokens: 0 });
      }
      this.ensureTimer();
    } else if (taskId) {
      this.activeTaskIds.delete(taskId);
    }
    this.update();
  }

  /** Record token usage for the currently active task(s). */
  addTokenUsage(inputTokens: number, outputTokens: number) {
    // Distribute to all currently active tasks
    for (const id of this.activeTaskIds) {
      const m = this.metrics.get(id);
      if (m) {
        m.inputTokens += inputTokens;
        m.outputTokens += outputTokens;
      }
    }
  }

  /** Set or update budget info for a task. */
  setBudget(taskId: string, info: TaskBudgetInfo) {
    this.budgets.set(taskId, info);
  }

  /** Remove budget info for a task. */
  clearBudget(taskId: string) {
    this.budgets.delete(taskId);
  }

  /** Ensure the animation timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => {
        this.widgetFrame++;
        if (this.tui) this.tui.requestRender();
      }, 80);
    }
  }

  /** Build widget lines from cached state. Called from the render callback. */
  private renderWidget(tui: any, theme: Theme): string[] {
    const tasks = this.cachedTasks;
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);

    if (tasks.length === 0) return [];

    const taskMap = new Map(tasks.map(t => [t.id, t]));

    const completed = tasks.filter(t => t.status === "completed");
    const skipped = tasks.filter(t => t.status === "skipped");
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const pending = tasks.filter(t => t.status === "pending");
    const activeTasks = [...pending, ...inProgress];
    const terminalTasks = [...completed, ...skipped];

    const parts: string[] = [];
    if (completed.length > 0) parts.push(`${completed.length} done`);
    if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
    if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`);
    if (pending.length > 0) parts.push(`${pending.length} open`);
    const statusText = `${tasks.length} tasks (${parts.join(", ")})`;

    const spinnerChar = SPINNER[this.widgetFrame % SPINNER.length];
    const lines: string[] = [truncate(theme.fg("accent", "●") + " " + theme.fg("accent", statusText))];

    const collapseTerminal = activeTasks.length >= 3 && terminalTasks.length > 0;
    const visibleTasks = collapseTerminal ? activeTasks.slice(0, MAX_VISIBLE_TASKS) : tasks.slice(0, MAX_VISIBLE_TASKS);

    for (const task of visibleTasks) {
      lines.push(truncate(this.renderTaskLine(task, taskMap, spinnerChar, theme)));
    }

    if (collapseTerminal) {
      const summaryParts: string[] = [];
      if (completed.length > 0) summaryParts.push(`${completed.length} completed`);
      if (skipped.length > 0) summaryParts.push(`${skipped.length} skipped`);
      lines.push(truncate(theme.fg("dim", `    ${summaryParts.join(", ")}`)));
    }

    const totalAvailable = collapseTerminal ? activeTasks.length : tasks.length;
    if (visibleTasks.length < totalAvailable) {
      lines.push(truncate(theme.fg("dim", `    … and ${totalAvailable - visibleTasks.length} more`)));
    }

    return lines;
  }

  private renderTaskLine(
    task: import("../types.js").Task,
    taskMap: Map<string, import("../types.js").Task>,
    spinnerChar: string,
    theme: Theme,
  ): string {
    const isActive = this.activeTaskIds.has(task.id) && task.status === "in_progress";

    let icon: string;
    if (isActive) {
      icon = theme.fg("accent", spinnerChar);
    } else if (task.status === "completed") {
      icon = theme.fg("success", "✔");
    } else if (task.status === "skipped") {
      icon = theme.fg("dim", "⊘");
    } else if (task.status === "in_progress") {
      icon = theme.fg("accent", "◼");
    } else {
      icon = "◻";
    }

    let suffix = "";
    if (task.status === "pending" && task.blockedBy.length > 0) {
      const openBlockers = task.blockedBy.filter(bid => {
        const blocker = taskMap.get(bid);
        return blocker && !isTerminalStatus(blocker.status);
      });
      if (openBlockers.length > 0) {
        suffix = theme.fg("dim", ` › blocked by ${openBlockers.map(id => "#" + id).join(", ")}`);
      }
    }

    let text: string;
    if (isActive) {
      const form = task.activeForm || task.subject;
      const agentId = task.metadata?.agentId;
      const agentLabel = agentId ? ` (agent ${agentId.slice(0, 5)})` : "";
      const m = this.metrics.get(task.id);
      let stats = "";
      if (m) {
        const elapsed = formatDuration(Date.now() - m.startedAt);
        const tokenParts: string[] = [];
        if (m.inputTokens > 0) tokenParts.push(`↑ ${formatTokens(m.inputTokens)}`);
        if (m.outputTokens > 0) tokenParts.push(`↓ ${formatTokens(m.outputTokens)}`);
        stats = tokenParts.length > 0
          ? ` ${theme.fg("dim", `(${elapsed} · ${tokenParts.join(" ")})`)}`
          : ` ${theme.fg("dim", `(${elapsed})`)}`;
      }
      const budgetInfo = this.budgets.get(task.id);
      let budgetText = "";
      if (budgetInfo) {
        const budgetParts: string[] = [];
        if (budgetInfo.timeoutMs) {
          const remaining = Math.max(0, budgetInfo.timeoutMs - (Date.now() - budgetInfo.startedAt));
          budgetParts.push(`⏱ ${formatDuration(remaining)} left`);
        }
        if (budgetInfo.tokenBudget) {
          const pct = Math.round((budgetInfo.tokensUsed / budgetInfo.tokenBudget) * 100);
          budgetParts.push(`${pct}% budget`);
        }
        if (budgetParts.length > 0) {
          budgetText = ` ${theme.fg("dim", `[${budgetParts.join(" · ")}]`)}`;
        }
      }
      text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${theme.fg("accent", form + agentLabel + "…")}${stats}${budgetText}`;
    } else if (task.status === "completed") {
      text = `  ${icon} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}`;
    } else if (task.status === "skipped") {
      text = `  ${icon} ${theme.fg("dim", "#" + task.id + " " + task.subject)}`;
    } else {
      const agentSuffix = task.status === "in_progress" && task.metadata?.agentId
        ? theme.fg("dim", ` (agent ${task.metadata.agentId.slice(0, 5)})`)
        : "";
      text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${task.subject}${agentSuffix}`;
    }

    return text + suffix;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const tasks = this.store.list();
    this.cachedTasks = tasks;

    // Transition: visible → hidden
    if (tasks.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("tasks", undefined);
        this.widgetRegistered = false;
      }
      if (this.widgetInterval) {
        clearInterval(this.widgetInterval);
        this.widgetInterval = undefined;
      }
      return;
    }

    const taskMap = new Map(tasks.map(t => [t.id, t]));

    // Prune stale active IDs (deleted or no longer in_progress)
    for (const id of this.activeTaskIds) {
      const t = taskMap.get(id);
      if (!t || t.status !== "in_progress") {
        this.activeTaskIds.delete(id);
        this.metrics.delete(id);
        this.budgets.delete(id);
      }
    }

    // Check if any task needs animation
    const hasActiveSpinner = tasks.some(t => this.activeTaskIds.has(t.id) && t.status === "in_progress");
    if (hasActiveSpinner) {
      this.ensureTimer();
    } else if (!hasActiveSpinner && this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }

    this.widgetFrame++;

    // Transition: hidden → visible — register widget callback once
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("tasks", (tui, theme) => {
        this.tui = tui;
        return { render: () => this.renderWidget(tui, theme), invalidate: () => {} };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else if (this.tui) {
      // Widget already registered — just request a re-render
      this.tui.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("tasks", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.budgets.clear();
    this.cachedTasks = [];
  }
}
