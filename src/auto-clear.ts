/**
 * auto-clear.ts — Turn-based auto-clearing of completed tasks.
 *
 * Two modes:
 * - "on_task_complete": each completed task gets its own REMINDER_INTERVAL countdown, deleted individually
 * - "on_list_complete": countdown starts when ALL tasks are completed, cleared as a batch
 *
 * Both use the same turn delay (REMINDER_INTERVAL) for consistency.
 */

import type { TaskStore } from "./task-store.js";

export type AutoClearMode = "never" | "on_list_complete" | "on_task_complete";

export class AutoClearManager {
  /** Per-task: turn when task was marked completed ("on_task_complete" mode). */
  private completedAtTurn = new Map<string, number>();
  /** Turn when ALL tasks became completed ("on_list_complete" mode). */
  private allCompletedAtTurn: number | null = null;

  constructor(
    private getStore: () => TaskStore,
    private getMode: () => AutoClearMode,
    /** How many turns completed tasks linger before auto-clearing. */
    private clearDelayTurns = 4,
  ) {}

  /** Record a task completion. Call AFTER cascade logic. */
  trackCompletion(taskId: string, currentTurn: number): void {
    const mode = this.getMode();
    if (mode === "never") return;

    if (mode === "on_task_complete") {
      this.completedAtTurn.set(taskId, currentTurn);
    } else if (mode === "on_list_complete") {
      this.checkAllCompleted(currentTurn);
    }
  }

  /** Check if all tasks are completed and start/reset the batch countdown. */
  private checkAllCompleted(currentTurn: number): void {
    const tasks = this.getStore().list();
    if (tasks.length > 0 && tasks.every(t => t.status === "completed")) {
      if (this.allCompletedAtTurn === null) this.allCompletedAtTurn = currentTurn;
    } else {
      this.allCompletedAtTurn = null;
    }
  }

  /** Reset batch countdown (e.g., when a new task is created or task goes non-completed). */
  resetBatchCountdown(): void {
    this.allCompletedAtTurn = null;
  }

  /** Reset all tracking state (e.g., on new session). */
  reset(): void {
    this.completedAtTurn.clear();
    this.allCompletedAtTurn = null;
  }

  /**
   * Called on each turn start. Deletes tasks whose linger period has expired.
   *
   * Returns the IDs of tasks that were cleared this turn (empty array if none).
   * The caller can use this list to nudge the LLM (e.g., via a system-reminder)
   * so it does not later try to update tasks that have silently disappeared.
   */
  onTurnStart(currentTurn: number): { cleared: boolean; ids: string[] } {
    const mode = this.getMode();
    const ids: string[] = [];

    if (mode === "on_task_complete") {
      for (const [taskId, turn] of this.completedAtTurn) {
        const task = this.getStore().get(taskId);
        if (!task || task.status !== "completed") {
          // Task was deleted or reverted — drop stale tracking entry
          this.completedAtTurn.delete(taskId);
        } else if (currentTurn - turn >= this.clearDelayTurns) {
          this.getStore().delete(taskId);
          this.completedAtTurn.delete(taskId);
          ids.push(taskId);
        }
      }
    } else if (mode === "on_list_complete" && this.allCompletedAtTurn !== null) {
      if (currentTurn - this.allCompletedAtTurn >= this.clearDelayTurns) {
        // Capture IDs before clearing so we can surface them to the caller.
        const completedIds = this.getStore().list().filter(t => t.status === "completed").map(t => t.id);
        this.getStore().clearCompleted();
        this.allCompletedAtTurn = null;
        ids.push(...completedIds);
      }
    }

    return { cleared: ids.length > 0, ids };
  }
}
