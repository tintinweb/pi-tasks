import { beforeEach, describe, expect, it } from "vitest";
import type { AutoClearMode } from "../src/auto-clear.js";
import { AutoClearManager } from "../src/auto-clear.js";
import { TaskStore } from "../src/task-store.js";

describe("auto-clear: on_task_complete mode", () => {
  let store: TaskStore;
  let manager: AutoClearManager;

  beforeEach(() => {
    store = new TaskStore();
    manager = new AutoClearManager(() => store, () => "on_task_complete");
  });

  it("does not clear completed task before REMINDER_INTERVAL turns", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    // Turns 2, 3, 4 — not enough
    for (let turn = 2; turn <= 4; turn++) {
      manager.onTurnStart(turn);
    }
    expect(store.get("1")).toBeDefined();
    expect(store.get("1")!.status).toBe("completed");
  });

  it("clears completed task after REMINDER_INTERVAL turns", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    // Turn 5 = turn 1 + 4 (REMINDER_INTERVAL)
    manager.onTurnStart(5);
    expect(store.get("1")).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });

  it("clears each task independently based on its own completion turn", () => {
    store.create("Task A", "Desc");
    store.create("Task B", "Desc");

    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    store.update("2", { status: "completed" });
    manager.trackCompletion("2", 3);

    // Turn 5: Task A expires (1+4), Task B still lingers (3+4=7)
    manager.onTurnStart(5);
    expect(store.get("1")).toBeUndefined();
    expect(store.get("2")).toBeDefined();

    // Turn 7: Task B expires
    manager.onTurnStart(7);
    expect(store.get("2")).toBeUndefined();
  });

  it("does not clear pending or in_progress tasks", () => {
    store.create("Pending", "Desc");
    store.create("In Progress", "Desc");
    store.create("Completed", "Desc");
    store.update("2", { status: "in_progress" });
    store.update("3", { status: "completed" });
    manager.trackCompletion("3", 1);

    manager.onTurnStart(5);
    expect(store.get("1")).toBeDefined(); // pending — untouched
    expect(store.get("2")).toBeDefined(); // in_progress — untouched
    expect(store.get("3")).toBeUndefined(); // completed — cleared
  });

  it("cleans up dependency edges when auto-clearing", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");
    store.update("1", { addBlocks: ["2"] });
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    manager.onTurnStart(5);
    expect(store.get("1")).toBeUndefined();
    expect(store.get("2")!.blockedBy).toEqual([]);
  });

  it("returns cleared=true and ids when tasks are cleared", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    expect(manager.onTurnStart(4)).toEqual({ cleared: false, ids: [] });
    expect(manager.onTurnStart(5)).toEqual({ cleared: true, ids: ["1"] });
  });
});

describe("auto-clear: on_list_complete mode", () => {
  let store: TaskStore;
  let manager: AutoClearManager;

  beforeEach(() => {
    store = new TaskStore();
    manager = new AutoClearManager(() => store, () => "on_list_complete");
  });

  it("does not clear when some tasks are still pending", () => {
    store.create("Done", "Desc");
    store.create("Pending", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    for (let turn = 2; turn <= 10; turn++) {
      manager.onTurnStart(turn);
    }
    expect(store.get("1")).toBeDefined();
    expect(store.list()).toHaveLength(2);
  });

  it("does not clear immediately when all tasks complete", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    store.update("1", { status: "completed" });
    store.update("2", { status: "completed" });
    manager.trackCompletion("2", 1);

    // Turns 2-4: not enough
    for (let turn = 2; turn <= 4; turn++) {
      manager.onTurnStart(turn);
    }
    expect(store.list()).toHaveLength(2);
  });

  it("clears all completed tasks after REMINDER_INTERVAL turns when all are completed", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    store.update("1", { status: "completed" });
    store.update("2", { status: "completed" });
    manager.trackCompletion("2", 1);

    manager.onTurnStart(5);
    expect(store.list()).toHaveLength(0);
  });

  it("resets countdown when a new task is created before REMINDER_INTERVAL", () => {
    store.create("A", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    // Turn 3: new task created — reset countdown
    manager.onTurnStart(3);
    manager.resetBatchCountdown();
    store.create("B", "Desc");

    // Turn 5 would have cleared, but countdown was reset at turn 3
    manager.onTurnStart(5);
    expect(store.get("1")).toBeDefined(); // still around — list isn't all completed
  });

  it("resets countdown when a task goes back to in_progress", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    store.update("1", { status: "completed" });
    store.update("2", { status: "completed" });
    manager.trackCompletion("2", 1);

    // Turn 3: task 2 goes back to in_progress
    manager.onTurnStart(3);
    store.update("2", { status: "in_progress" });
    manager.resetBatchCountdown();

    // Turn 5: would have cleared, but countdown was reset
    manager.onTurnStart(5);
    expect(store.list()).toHaveLength(2); // both still here
  });

  it("returns true when tasks are cleared", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    expect(manager.onTurnStart(4)).toEqual({ cleared: false, ids: [] });
    const result = manager.onTurnStart(5);
    expect(result.cleared).toBe(true);
    expect(result.ids.sort()).toEqual(["1"]);
  });
});

describe("auto-clear: never mode", () => {
  let store: TaskStore;
  let manager: AutoClearManager;

  beforeEach(() => {
    store = new TaskStore();
    manager = new AutoClearManager(() => store, () => "never");
  });

  it("never clears completed tasks regardless of turns", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    store.update("1", { status: "completed" });
    store.update("2", { status: "completed" });
    manager.trackCompletion("1", 1);
    manager.trackCompletion("2", 1);

    for (let turn = 2; turn <= 20; turn++) {
      manager.onTurnStart(turn);
    }
    expect(store.list()).toHaveLength(2);
  });

  it("trackCompletion is a no-op", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    manager.onTurnStart(100);
    expect(store.get("1")).toBeDefined();
  });
});

describe("auto-clear: dynamic mode switching", () => {
  it("respects mode changes via getMode callback", () => {
    const store = new TaskStore();
    let mode: AutoClearMode = "never";
    const manager = new AutoClearManager(() => store, () => mode);

    store.create("Task", "Desc");
    store.update("1", { status: "completed" });

    // Track in never mode — no-op
    manager.trackCompletion("1", 1);
    manager.onTurnStart(5);
    expect(store.get("1")).toBeDefined();

    // Switch to on_task_complete and re-track
    mode = "on_task_complete";
    manager.trackCompletion("1", 5);
    manager.onTurnStart(9);
    expect(store.get("1")).toBeUndefined();
  });
});

describe("auto-clear: store getter (session switch)", () => {
  it("operates on the current store after swap", () => {
    let store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_task_complete");

    store.create("Old task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    // Simulate session switch — swap store
    store = new TaskStore();
    store.create("New task", "Desc");
    manager.reset();

    // Old task tracking was reset, new store has no completed tasks
    manager.onTurnStart(5);
    expect(store.list()).toHaveLength(1);
    expect(store.get("1")!.subject).toBe("New task");
  });

  it("clears from new store, not old store", () => {
    let store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_task_complete");

    // Swap to new store with a completed task
    store = new TaskStore();
    store.create("Task in new store", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    manager.onTurnStart(5);
    expect(store.get("1")).toBeUndefined(); // cleared from new store
  });
});

describe("auto-clear: reset (new session)", () => {
  it("reset clears per-task tracking so old completions don't fire", () => {
    const store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_task_complete");

    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    // Simulate /new — reset before the delay expires
    manager.reset();

    // Old completion should NOT trigger after reset
    manager.onTurnStart(5);
    expect(store.get("1")).toBeDefined();
  });

  it("reset clears batch countdown so old all-completed state doesn't fire", () => {
    const store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_list_complete");

    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    // Simulate /new — reset before the delay expires
    manager.reset();

    // Old batch countdown should NOT trigger after reset
    manager.onTurnStart(5);
    expect(store.get("1")).toBeDefined();
  });

  it("tracking works normally after reset", () => {
    const store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_task_complete");

    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);
    manager.reset();

    // Re-track after reset with new turn baseline
    manager.trackCompletion("1", 10);
    manager.onTurnStart(14);
    expect(store.get("1")).toBeUndefined();
  });
});
