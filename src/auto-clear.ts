/**
 * auto-clear.ts — Auto-clearing of completed tasks.
 *
 * Two modes:
 * - "on_task_complete": each completed task gets its own turn countdown, then is deleted individually
 * - "on_list_complete": the whole list is cleared immediately when its final task completes
 */

import type { TaskStore } from "./task-store.js";

export type AutoClearMode = "never" | "on_list_complete" | "on_task_complete";

export class AutoClearManager {
  /** Per-task: turn when task was marked completed ("on_task_complete" mode). */
  private completedAtTurn = new Map<string, number>();

  constructor(
    private getStore: () => TaskStore,
    private getMode: () => AutoClearMode,
    /** How many turns individual completed tasks linger before auto-clearing. */
    private clearDelayTurns = 4,
  ) {}

  /** Record a task completion. Call AFTER cascade logic. */
  trackCompletion(taskId: string, currentTurn: number): void {
    const mode = this.getMode();
    if (mode === "never") return;

    if (mode === "on_task_complete") {
      this.completedAtTurn.set(taskId, currentTurn);
    } else if (mode === "on_list_complete") {
      const store = this.getStore();
      const tasks = store.list();
      if (tasks.length > 0 && tasks.every(t => t.status === "completed")) {
        store.clearCompleted();
      }
    }
  }

  /** Reset all tracking state (e.g., on new session). */
  reset(): void {
    this.completedAtTurn.clear();
  }

  /**
   * Called on each turn start. Deletes tasks whose linger period has expired.
   * Returns true if any tasks were cleared.
   */
  onTurnStart(currentTurn: number): boolean {
    const mode = this.getMode();
    let cleared = false;

    if (mode === "on_task_complete") {
      for (const [taskId, turn] of this.completedAtTurn) {
        const task = this.getStore().get(taskId);
        if (!task || task.status !== "completed") {
          // Task was deleted or reverted — drop stale tracking entry
          this.completedAtTurn.delete(taskId);
        } else if (currentTurn - turn >= this.clearDelayTurns) {
          this.getStore().delete(taskId);
          this.completedAtTurn.delete(taskId);
          cleared = true;
        }
      }
    }

    return cleared;
  }
}
