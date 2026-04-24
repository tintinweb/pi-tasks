/**
 * types.ts — Type definitions for the task management system.
 */

export type TaskStatus = "pending" | "in_progress" | "completed" | "skipped";

/** Returns true when a task status counts as resolved for dependency purposes. */
export function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "skipped";
}

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  metadata: Record<string, any>;
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

/** Serialized store format on disk. */
export interface TaskStoreData {
  nextId: number;
  tasks: Task[];
}

/** Per-task budget/timeout tracking for TaskExecute. */
export interface TaskBudget {
  startedAt: number;
  tokenBudget?: number;
  tokensUsed: number;
  timeoutMs?: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Background process associated with a task. */
export interface BackgroundProcess {
  taskId: string;
  pid: number;
  command?: string;
  output: string[];
  totalBytes: number;
  status: "running" | "completed" | "error" | "stopped";
  exitCode?: number;
  signal?: string;
  startedAt: number;
  completedAt?: number;
  proc: import("node:child_process").ChildProcess;
  abortController: AbortController;
  waiters: Array<() => void>;
}
