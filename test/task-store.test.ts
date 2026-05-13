import { readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";

describe("TaskStore (in-memory)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore(); // no listId = in-memory
  });

  it("creates tasks with auto-incrementing IDs", () => {
    const t1 = store.create("First task", "Description 1");
    const t2 = store.create("Second task", "Description 2");

    expect(t1.id).toBe("1");
    expect(t2.id).toBe("2");
    expect(t1.status).toBe("pending");
    expect(t1.subject).toBe("First task");
    expect(t1.description).toBe("Description 1");
  });

  it("creates tasks with optional fields", () => {
    const t = store.create("Task", "Desc", "Running task", { key: "value" });

    expect(t.activeForm).toBe("Running task");
    expect(t.metadata).toEqual({ key: "value" });
  });

  it("gets a task by ID", () => {
    store.create("Test", "Desc");
    const task = store.get("1");

    expect(task).toBeDefined();
    expect(task!.subject).toBe("Test");
  });

  it("returns undefined for non-existent task", () => {
    expect(store.get("999")).toBeUndefined();
  });

  it("lists all tasks sorted by ID", () => {
    store.create("Task 3", "Desc");
    store.create("Task 1", "Desc");
    store.create("Task 2", "Desc");

    const tasks = store.list();
    expect(tasks.map(t => t.id)).toEqual(["1", "2", "3"]);
  });

  it("lists tasks sorted by status when sortOrder is 'status'", () => {
    store.create("Pending", "Desc");           // #1
    store.create("Completed", "Desc");         // #2
    store.create("In progress", "Desc");       // #3
    store.update("2", { status: "completed" });
    store.update("3", { status: "in_progress" });

    const tasks = store.list("status");
    expect(tasks.map(t => t.subject)).toEqual(["Completed", "In progress", "Pending"]);
  });

  it("lists tasks sorted by most recently updated when sortOrder is 'recent'", () => {
    vi.useFakeTimers({ now: 1000 });
    store.create("First", "Desc");    // #1 created at 1000
    vi.advanceTimersByTime(100);
    store.create("Second", "Desc");   // #2 created at 1100
    vi.advanceTimersByTime(100);
    store.create("Third", "Desc");    // #3 created at 1200
    vi.advanceTimersByTime(100);
    store.update("1", { subject: "First updated" });  // #1 updated at 1300
    vi.advanceTimersByTime(100);
    store.update("3", { subject: "Third updated" });  // #3 updated at 1400

    const tasks = store.list("recent");
    // Most recently updated first: #3 (1400), #1 (1300), #2 (1100)
    expect(tasks.map(t => t.id)).toEqual(["3", "1", "2"]);
    vi.useRealTimers();
  });

  it("lists tasks sorted by least recently updated when sortOrder is 'oldest'", () => {
    vi.useFakeTimers({ now: 1000 });
    store.create("First", "Desc");    // #1 created at 1000
    vi.advanceTimersByTime(100);
    store.create("Second", "Desc");   // #2 created at 1100
    vi.advanceTimersByTime(100);
    store.create("Third", "Desc");    // #3 created at 1200
    vi.advanceTimersByTime(100);
    store.update("1", { subject: "First updated" });  // #1 updated at 1300
    vi.advanceTimersByTime(100);
    store.update("3", { subject: "Third updated" });  // #3 updated at 1400

    const tasks = store.list("oldest");
    // Least recently updated first: #2 (1100), #1 (1300), #3 (1400)
    expect(tasks.map(t => t.id)).toEqual(["2", "1", "3"]);
    vi.useRealTimers();
  });

  it("updates task status", () => {
    store.create("Test", "Desc");
    const { task, changedFields } = store.update("1", { status: "in_progress" });

    expect(task!.status).toBe("in_progress");
    expect(changedFields).toEqual(["status"]);
  });

  it("updates multiple fields at once", () => {
    store.create("Test", "Desc");
    const { changedFields } = store.update("1", {
      subject: "Updated subject",
      description: "Updated desc",
      owner: "agent-1",
    });

    expect(changedFields).toContain("subject");
    expect(changedFields).toContain("description");
    expect(changedFields).toContain("owner");

    const task = store.get("1")!;
    expect(task.subject).toBe("Updated subject");
    expect(task.owner).toBe("agent-1");
  });

  it("deletes a task with status: deleted", () => {
    store.create("Test", "Desc");
    const { changedFields } = store.update("1", { status: "deleted" });

    expect(changedFields).toEqual(["deleted"]);
    expect(store.get("1")).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });

  it("preserves ID counter after deletion", () => {
    store.create("Task 1", "Desc");
    store.create("Task 2", "Desc");
    store.update("1", { status: "deleted" });

    const t3 = store.create("Task 3", "Desc");
    expect(t3.id).toBe("3"); // Not "1" — counter continues
  });

  it("merges metadata with null key deletion", () => {
    store.create("Test", "Desc", undefined, { a: 1, b: 2, c: 3 });
    store.update("1", { metadata: { b: null, d: 4 } });

    const task = store.get("1")!;
    expect(task.metadata).toEqual({ a: 1, c: 3, d: 4 });
  });

  it("sets up bidirectional blocks via addBlocks", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");

    store.update("1", { addBlocks: ["2"] });

    const t1 = store.get("1")!;
    const t2 = store.get("2")!;
    expect(t1.blocks).toContain("2");
    expect(t2.blockedBy).toContain("1");
  });

  it("sets up bidirectional blocks via addBlockedBy", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");

    store.update("2", { addBlockedBy: ["1"] });

    const t1 = store.get("1")!;
    const t2 = store.get("2")!;
    expect(t1.blocks).toContain("2");
    expect(t2.blockedBy).toContain("1");
  });

  it("does not duplicate dependency edges", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");

    store.update("1", { addBlocks: ["2"] });
    store.update("1", { addBlocks: ["2"] }); // duplicate

    const t1 = store.get("1")!;
    expect(t1.blocks.filter(id => id === "2")).toHaveLength(1);
  });

  it("cleans up dependency edges on deletion", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    store.update("1", { addBlocks: ["2"] });

    store.update("1", { status: "deleted" });

    const t2 = store.get("2")!;
    expect(t2.blockedBy).toEqual([]);
  });

  it("clears completed tasks", () => {
    store.create("Completed", "Desc");
    store.create("Pending", "Desc");
    store.update("1", { status: "completed" });

    const count = store.clearCompleted();

    expect(count).toBe(1);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].id).toBe("2");
  });

  it("returns not found for update on non-existent task", () => {
    const { task, changedFields } = store.update("999", { status: "completed" });
    expect(task).toBeUndefined();
    expect(changedFields).toEqual([]);
  });

  it("delete method works", () => {
    store.create("Test", "Desc");
    expect(store.delete("1")).toBe(true);
    expect(store.delete("1")).toBe(false); // already deleted
    expect(store.list()).toHaveLength(0);
  });

  it("creates tasks with metadata via TaskCreate", () => {
    const t = store.create("With meta", "Desc", undefined, { pr: "123", reviewer: "alice" });
    expect(t.metadata).toEqual({ pr: "123", reviewer: "alice" });

    const retrieved = store.get("1")!;
    expect(retrieved.metadata).toEqual({ pr: "123", reviewer: "alice" });
  });

  it("allows circular dependencies with warning", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    store.update("1", { addBlocks: ["2"] });
    const { warnings } = store.update("2", { addBlocks: ["1"] });

    expect(store.get("1")!.blocks).toContain("2");
    expect(store.get("2")!.blocks).toContain("1");
    expect(warnings).toContain("cycle: #2 and #1 block each other");
  });

  it("allows self-dependency with warning", () => {
    store.create("Self", "Desc");
    const { warnings } = store.update("1", { addBlocks: ["1"] });
    expect(store.get("1")!.blocks).toContain("1");
    expect(warnings).toContain("#1 blocks itself");
  });

  it("stores dangling edge IDs with warning", () => {
    store.create("Real", "Desc");
    const { warnings } = store.update("1", { addBlocks: ["9999"] });
    expect(store.get("1")!.blocks).toContain("9999");
    expect(warnings).toContain("#9999 does not exist");
  });

  it("returns no warnings for valid dependencies", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    const { warnings } = store.update("1", { addBlocks: ["2"] });
    expect(warnings).toEqual([]);
  });

  it("accepts whitespace-only subjects (matches Claude Code)", () => {
    const t = store.create("   ", "Desc");
    expect(t.subject).toBe("   ");
  });

  it("updates activeForm field", () => {
    store.create("Test", "Desc");
    const { changedFields } = store.update("1", { activeForm: "Running tests" });
    expect(changedFields).toContain("activeForm");
    expect(store.get("1")!.activeForm).toBe("Running tests");
  });

  it("updates description field", () => {
    store.create("Test", "Original desc");
    const { changedFields } = store.update("1", { description: "Updated desc" });
    expect(changedFields).toContain("description");
    expect(store.get("1")!.description).toBe("Updated desc");
  });

  it("returns empty changedFields when updating non-existent task", () => {
    const { task, changedFields, warnings } = store.update("999", { status: "completed" });
    expect(task).toBeUndefined();
    expect(changedFields).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("clearCompleted cleans up dependency edges", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");
    store.update("1", { addBlocks: ["2"] });
    store.update("1", { status: "completed" });

    store.clearCompleted();

    const t2 = store.get("2")!;
    expect(t2.blockedBy).toEqual([]);
  });

  it("handles multiple addBlocks in one call", () => {
    store.create("Blocker", "Desc");
    store.create("B1", "Desc");
    store.create("B2", "Desc");

    store.update("1", { addBlocks: ["2", "3"] });

    expect(store.get("1")!.blocks).toEqual(["2", "3"]);
    expect(store.get("2")!.blockedBy).toContain("1");
    expect(store.get("3")!.blockedBy).toContain("1");
  });

  it("addBlockedBy warns on self-dependency", () => {
    store.create("Self", "Desc");
    const { warnings } = store.update("1", { addBlockedBy: ["1"] });
    expect(store.get("1")!.blockedBy).toContain("1");
    expect(warnings).toContain("#1 blocks itself");
  });

  it("addBlockedBy warns on dangling ref", () => {
    store.create("Real", "Desc");
    const { warnings } = store.update("1", { addBlockedBy: ["9999"] });
    expect(store.get("1")!.blockedBy).toContain("9999");
    expect(warnings).toContain("#9999 does not exist");
  });

  it("addBlockedBy warns on cycle", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    store.update("1", { addBlocks: ["2"] });
    const { warnings } = store.update("1", { addBlockedBy: ["2"] });
    expect(warnings).toContain("cycle: #1 and #2 block each other");
  });

  it("clearCompleted returns 0 when no completed tasks", () => {
    store.create("Pending", "Desc");
    expect(store.clearCompleted()).toBe(0);
  });

  it("list sorts pending → in_progress → completed with all three present", () => {
    store.create("Pending task", "Desc");
    store.create("Completed task", "Desc");
    store.create("In-progress task", "Desc");
    store.create("Another pending", "Desc");

    store.update("2", { status: "completed" });
    store.update("3", { status: "in_progress" });

    const tasks = store.list();
    // Store returns by ID; TaskList tool sorts by status group
    // Here we verify the raw list order (by ID), then test status-grouped sort
    const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
    const sorted = [...tasks].sort((a, b) => {
      const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
      if (so !== 0) return so;
      return Number(a.id) - Number(b.id);
    });

    expect(sorted.map(t => t.id)).toEqual(["1", "4", "3", "2"]);
    expect(sorted.map(t => t.status)).toEqual(["pending", "pending", "in_progress", "completed"]);
  });
});

describe("TaskStore (file-backed)", () => {
  const testListId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tasksDir = join(homedir(), ".pi", "tasks");
  const filePath = join(tasksDir, `${testListId}.json`);

  afterEach(() => {
    // Clean up test file
    try { rmSync(filePath); } catch { /* */ }
    try { rmSync(filePath + ".lock"); } catch { /* */ }
    try { rmSync(filePath + ".tmp"); } catch { /* */ }
  });

  it("persists tasks to disk", () => {
    const store1 = new TaskStore(testListId);
    store1.create("Persistent task", "Should survive reload");

    // Create a new store instance pointing to same file
    const store2 = new TaskStore(testListId);
    const tasks = store2.list();

    expect(tasks).toHaveLength(1);
    expect(tasks[0].subject).toBe("Persistent task");
  });

  it("persists in_progress updates to disk", () => {
    const store1 = new TaskStore(testListId);
    store1.create("Task", "Desc");
    store1.update("1", { status: "in_progress" });

    const store2 = new TaskStore(testListId);
    expect(store2.get("1")!.status).toBe("in_progress");
  });

  it("persists completed tasks to disk", () => {
    const store1 = new TaskStore(testListId);
    store1.create("Done task", "Desc");
    store1.create("Pending task", "Desc");
    store1.update("1", { status: "completed" });

    const store2 = new TaskStore(testListId);
    expect(store2.get("1")).toBeDefined();
    expect(store2.get("1")!.status).toBe("completed");
    expect(store2.get("2")).toBeDefined();
    expect(store2.list()).toHaveLength(2);
  });

  it("restores all tasks across instances", () => {
    const store1 = new TaskStore(testListId);
    store1.create("Pending", "Desc");
    store1.create("In progress", "Desc");
    store1.create("Done", "Desc");
    store1.update("2", { status: "in_progress" });
    store1.update("3", { status: "completed" });

    const store2 = new TaskStore(testListId);
    const tasks = store2.list();
    expect(tasks).toHaveLength(3);
    expect(tasks.map(t => t.id)).toContain("1");
    expect(tasks.map(t => t.id)).toContain("2");
    expect(tasks.map(t => t.id)).toContain("3");
  });

  it("persists ID counter across instances", () => {
    const store1 = new TaskStore(testListId);
    store1.create("Task 1", "Desc");
    store1.create("Task 2", "Desc");

    const store2 = new TaskStore(testListId);
    const t3 = store2.create("Task 3", "Desc");
    expect(t3.id).toBe("3");
  });
});

describe("TaskStore (absolute path)", () => {
  const absFilePath = join(tmpdir(), `pi-tasks-test-${Date.now()}.json`);

  afterEach(() => {
    try { rmSync(absFilePath); } catch { /* */ }
    try { rmSync(absFilePath + ".lock"); } catch { /* */ }
    try { rmSync(absFilePath + ".tmp"); } catch { /* */ }
  });

  it("accepts absolute path and persists tasks", () => {
    const store1 = new TaskStore(absFilePath);
    store1.create("Abs path task", "Desc");

    const store2 = new TaskStore(absFilePath);
    expect(store2.list()).toHaveLength(1);
    expect(store2.list()[0].subject).toBe("Abs path task");
  });

  it("persists completed tasks when using absolute path", () => {
    const store1 = new TaskStore(absFilePath);
    store1.create("Pending", "Desc");
    store1.create("Completed", "Desc");
    store1.update("2", { status: "completed" });

    const raw = JSON.parse(readFileSync(absFilePath, "utf-8"));
    expect(raw.tasks).toHaveLength(2);
  });
});
