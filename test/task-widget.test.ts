import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";
import type { TasksConfig } from "../src/tasks-config.js";
import { TaskWidget, type Theme, type UICtx } from "../src/ui/task-widget.js";

/** Create a mock theme that returns raw text (no ANSI escapes). */
function mockTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    strikethrough: (text: string) => `~~${text}~~`,
  };
}

/** Create a mock UICtx that captures setWidget calls. */
function mockUICtx() {
  const state: {
    widgets: Map<string, any>;
    statuses: Map<string, string | undefined>;
  } = {
    widgets: new Map(),
    statuses: new Map(),
  };

  const ctx: UICtx = {
    setWidget(key, content, options) {
      state.widgets.set(key, { content, options });
    },
    setStatus(key, text) {
      state.statuses.set(key, text);
    },
  };

  return { ctx, state };
}

/** Render the widget and return its lines. */
function renderWidget(state: ReturnType<typeof mockUICtx>["state"], columns = 200): string[] {
  const entry = state.widgets.get("tasks");
  if (!entry?.content) return [];
  const theme = mockTheme();
  const tui = { terminal: { columns }, requestRender() {} };
  const result = entry.content(tui, theme);
  return result.render();
}

describe("TaskWidget", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TaskStore();
    widget = new TaskWidget(store);
    ui = mockUICtx();
    widget.setUICtx(ui.ctx);
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  it("shows nothing when no tasks exist", () => {
    widget.update();
    const entry = ui.state.widgets.get("tasks");
    expect(entry?.content).toBeUndefined();
  });

  it("renders pending tasks with ◻ icon", () => {
    store.create("Do something", "Desc");
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines).toHaveLength(2); // header + 1 task
    expect(lines[0]).toContain("1 tasks");
    expect(lines[0]).toContain("1 open");
    expect(lines[1]).toContain("◻");
    expect(lines[1]).toContain("Do something");
  });

  it("renders in-progress tasks with ◼ icon", () => {
    store.create("Working on it", "Desc");
    store.update("1", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("◼");
    expect(lines[1]).toContain("Working on it");
  });

  it("renders completed tasks with ✔ icon and strikethrough", () => {
    store.create("Done task", "Desc");
    store.update("1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("✔");
    expect(lines[1]).toContain("~~#1 Done task~~");
  });

  it("renders active tasks with spinner icon", () => {
    store.create("Running thing", "Desc", "Processing data");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    // Should show activeForm text with "…" suffix
    expect(lines[1]).toContain("Processing data…");
    // Should NOT show ◼ for active task
    expect(lines[1]).not.toContain("◼");
  });

  it("shows blocked-by info for pending tasks", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");
    store.update("2", { addBlockedBy: ["1"] });
    widget.update();

    const lines = renderWidget(ui.state);
    const blockedLine = lines.find(l => l.includes("Blocked"));
    expect(blockedLine).toContain("blocked by #1");
  });

  it("hides completed blockers in blocked-by suffix", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");
    store.update("2", { addBlockedBy: ["1"] });
    store.update("1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    const blockedLine = lines.find(l => l.includes("Blocked"));
    expect(blockedLine).not.toContain("blocked by");
  });

  it("does not crash the host when a task is missing legacy fields", () => {
    // Simulate a record persisted before the blocking feature — no blockedBy.
    // A throw here would escape to the TUI timer and kill the whole pi process,
    // so the render must never throw (the guard returns a safe fallback).
    store.create("Legacy pending", "Desc");
    const raw = store.get("1") as any;
    delete raw.blockedBy;
    delete raw.blocks;
    delete raw.metadata;
    widget.update();

    expect(() => renderWidget(ui.state)).not.toThrow();
  });

  it("shows status summary in header", () => {
    store.create("Task A", "Desc");
    store.create("Task B", "Desc");
    store.create("Task C", "Desc");
    store.update("1", { status: "completed" });
    store.update("2", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[0]).toContain("3 tasks");
    expect(lines[0]).toContain("1 done");
    expect(lines[0]).toContain("1 in progress");
    expect(lines[0]).toContain("1 open");
  });

  it("clears widget when all tasks are deleted", () => {
    store.create("Task", "Desc");
    widget.update();
    expect(ui.state.widgets.get("tasks")?.content).toBeDefined();

    store.update("1", { status: "deleted" });
    widget.update();
    expect(ui.state.widgets.get("tasks")?.content).toBeUndefined();
  });

  it("limits visible tasks to MAX_VISIBLE_TASKS", () => {
    for (let i = 0; i < 15; i++) {
      store.create(`Task ${i + 1}`, "Desc");
    }
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 10 tasks + "… and 5 more"
    expect(lines).toHaveLength(12);
    expect(lines[11]).toContain("5 more");
  });

  it("respects maxVisible config", () => {
    widget = new TaskWidget(store, { maxVisible: 5 });
    widget.setUICtx(ui.ctx);
    for (let i = 0; i < 15; i++) {
      store.create(`Task ${i + 1}`, "Desc");
    }
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 5 tasks + "… and 10 more"
    expect(lines).toHaveLength(7);
    expect(lines[6]).toContain("10 more");
  });

  it("shows all tasks when limit exceeds task count", () => {
    widget = new TaskWidget(store, { maxVisible: 10 });
    widget.setUICtx(ui.ctx);
    for (let i = 0; i < 3; i++) {
      store.create(`Task ${i + 1}`, "Desc");
    }
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 3 tasks, no overflow
    expect(lines).toHaveLength(4);
    expect(lines[lines.length - 1]).not.toContain("more");
  });

  it("shows all tasks when showAll is true even with maxVisible set", () => {
    widget = new TaskWidget(store, { showAll: true, maxVisible: 5 });
    widget.setUICtx(ui.ctx);
    for (let i = 0; i < 15; i++) {
      store.create(`Task ${i + 1}`, "Desc");
    }
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 15 tasks, no overflow line
    expect(lines).toHaveLength(16);
    expect(lines[lines.length - 1]).not.toContain("more");
  });

  it("truncates from top when hiddenAt is 'top'", () => {
    widget = new TaskWidget(store, { sortOrder: "status", hiddenAt: "top", showAll: false, maxVisible: 5 });
    widget.setUICtx(ui.ctx);
    // 4 completed, 2 in_progress, 2 pending = 8 total, limit 5
    for (let i = 1; i <= 4; i++) store.create(`Done ${i}`, "Desc");
    for (let i = 1; i <= 2; i++) store.create(`Working ${i}`, "Desc");
    for (let i = 1; i <= 2; i++) store.create(`Todo ${i}`, "Desc");
    for (let i = 1; i <= 4; i++) store.update(String(i), { status: "completed" });
    for (let i = 5; i <= 6; i++) store.update(String(i), { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    // header + overflow line + 5 visible = 7 lines
    expect(lines).toHaveLength(7);
    // overflow at top (after header)
    expect(lines[1]).toContain("3 more");
    // all in_progress and pending visible
    expect(lines.some(l => l.includes("Working 1"))).toBe(true);
    expect(lines.some(l => l.includes("Todo 2"))).toBe(true);
    // only newest completed (#4) visible
    expect(lines.some(l => l.includes("Done 4"))).toBe(true);
    // oldest completed hidden
    expect(lines.some(l => l.includes("Done 1"))).toBe(false);
    expect(lines.some(l => l.includes("Done 3"))).toBe(false);
  });

  it("truncates from bottom when hiddenAt holds an unrecognised value", () => {
    widget = new TaskWidget(store, { hiddenAt: "middle" as "top", maxVisible: 3 });
    widget.setUICtx(ui.ctx);
    for (let i = 1; i <= 5; i++) store.create(`Task ${i}`, "Desc");
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain("Task 1");
    expect(lines[4]).toContain("2 more");
  });

  it("truncates from bottom by default", () => {
    widget = new TaskWidget(store, { maxVisible: 3 });
    widget.setUICtx(ui.ctx);
    for (let i = 1; i <= 5; i++) store.create(`Task ${i}`, "Desc");
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 3 tasks + overflow at bottom = 5 lines
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain("Task 1");
    expect(lines[3]).toContain("Task 3");
    expect(lines[4]).toContain("2 more");
    expect(lines.some(l => l.includes("Task 4"))).toBe(false);
  });

  describe("collapseCompleted", () => {
    /** 2 completed (#1,#2), 1 in_progress (#3), 2 pending (#4,#5). */
    function seed() {
      for (let i = 1; i <= 5; i++) store.create(`Task ${i}`, "Desc");
      store.update("1", { status: "completed" });
      store.update("2", { status: "completed" });
      store.update("3", { status: "in_progress" });
    }

    it("replaces completed tasks with a single count line", () => {
      widget = new TaskWidget(store, { collapseCompleted: true });
      widget.setUICtx(ui.ctx);
      seed();
      widget.update();

      const lines = renderWidget(ui.state);
      // header + #3 #4 #5 + count line
      expect(lines).toHaveLength(5);
      expect(lines.some(l => l.includes("Task 1"))).toBe(false);
      expect(lines.some(l => l.includes("Task 2"))).toBe(false);
      expect(lines[lines.length - 1]).toContain("2 completed");
    });

    it("leaves the header counts untouched", () => {
      widget = new TaskWidget(store, { collapseCompleted: true });
      widget.setUICtx(ui.ctx);
      seed();
      widget.update();

      expect(renderWidget(ui.state)[0]).toContain("5 tasks (2 done, 1 in progress, 2 open)");
    });

    it("applies the visible limit to the remaining tasks only", () => {
      widget = new TaskWidget(store, { collapseCompleted: true, maxVisible: 2 });
      widget.setUICtx(ui.ctx);
      seed();
      widget.update();

      const lines = renderWidget(ui.state);
      // header + #3 #4 + overflow + count line
      expect(lines).toHaveLength(5);
      expect(lines[1]).toContain("Task 3");
      expect(lines[2]).toContain("Task 4");
      // the overflow count excludes the collapsed completed tasks
      expect(lines[3]).toContain("1 more");
      expect(lines[4]).toContain("2 completed");
    });

    it("emits no count line when nothing is completed", () => {
      widget = new TaskWidget(store, { collapseCompleted: true });
      widget.setUICtx(ui.ctx);
      for (let i = 1; i <= 3; i++) store.create(`Task ${i}`, "Desc");
      widget.update();

      const lines = renderWidget(ui.state);
      expect(lines).toHaveLength(4);
      expect(lines.some(l => l.includes("completed"))).toBe(false);
    });

    it("stays visible as header plus count line when everything is completed", () => {
      widget = new TaskWidget(store, { collapseCompleted: true });
      widget.setUICtx(ui.ctx);
      for (let i = 1; i <= 3; i++) store.create(`Task ${i}`, "Desc");
      for (let i = 1; i <= 3; i++) store.update(String(i), { status: "completed" });
      widget.update();

      const lines = renderWidget(ui.state);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain("3 completed");
    });

    it("lists completed tasks individually when off", () => {
      widget = new TaskWidget(store, { collapseCompleted: false });
      widget.setUICtx(ui.ctx);
      seed();
      widget.update();

      const lines = renderWidget(ui.state);
      expect(lines).toHaveLength(6);
      expect(lines[1]).toContain("Task 1");
    });
  });

  it("sorts tasks by status when sortOrder is 'status'", () => {
    widget = new TaskWidget(store, { sortOrder: "status" });
    widget.setUICtx(ui.ctx);
    store.create("Pending task", "Desc");           // #1
    store.create("Completed task", "Desc");         // #2
    store.create("In progress task", "Desc");       // #3
    store.update("2", { status: "completed" });
    store.update("3", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 3 tasks: completed, in_progress, pending
    expect(lines[1]).toContain("Completed task");
    expect(lines[2]).toContain("In progress task");
    expect(lines[3]).toContain("Pending task");
  });

  it("sorts active work first when sortOrder is 'active'", () => {
    widget = new TaskWidget(store, { sortOrder: "active" });
    widget.setUICtx(ui.ctx);
    store.create("Pending task", "Desc");            // #1
    store.create("Completed task", "Desc");          // #2
    store.create("In progress task", "Desc");        // #3
    store.update("2", { status: "completed" });
    store.update("3", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("In progress task");
    expect(lines[2]).toContain("Pending task");
    expect(lines[3]).toContain("Completed task");
  });

  it("honours a custom sort spec from config", () => {
    widget = new TaskWidget(store, { sortOrder: [{ field: "id", direction: "desc" }] });
    widget.setUICtx(ui.ctx);
    for (let i = 1; i <= 3; i++) store.create(`Task ${i}`, "Desc");
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines.slice(1).map(l => l.match(/#(\d+)/)?.[1])).toEqual(["3", "2", "1"]);
  });

  it("defaults to ID order when sortOrder is unset", () => {
    store.create("Pending task", "Desc");           // #1
    store.create("Completed task", "Desc");         // #2
    store.create("In progress task", "Desc");       // #3
    store.update("2", { status: "completed" });
    store.update("3", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Pending task");
    expect(lines[2]).toContain("Completed task");
    expect(lines[3]).toContain("In progress task");
  });

  it("keeps ID order when sortOrder is 'id'", () => {
    widget = new TaskWidget(store, { sortOrder: "id" });
    widget.setUICtx(ui.ctx);
    store.create("Pending task", "Desc");           // #1
    store.create("Completed task", "Desc");         // #2
    store.create("In progress task", "Desc");       // #3
    store.update("2", { status: "completed" });
    store.update("3", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    // ID order: #1 pending, #2 completed, #3 in_progress
    expect(lines[1]).toContain("Pending task");
    expect(lines[2]).toContain("Completed task");
    expect(lines[3]).toContain("In progress task");
  });

  it("tracks token usage for active tasks", () => {
    store.create("Active task", "Desc", "Running");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.addTokenUsage(1000, 500);
    widget.addTokenUsage(500, 300);

    const lines = renderWidget(ui.state);
    const activeLine = lines.find(l => l.includes("Running…"));
    expect(activeLine).toContain("↑ 1.5k");
    expect(activeLine).toContain("↓ 800");
  });

  it("deactivates a task with setActiveTask(id, false)", () => {
    store.create("Task", "Desc", "Doing work");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    // Should be active (spinner)
    let lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Doing work…");

    widget.setActiveTask("1", false);
    lines = renderWidget(ui.state);
    // Should now show as regular in_progress (◼)
    expect(lines[1]).toContain("◼");
    expect(lines[1]).not.toContain("Doing work…");
  });

  it("prunes stale active IDs on update", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    // Complete the task externally
    store.update("1", { status: "completed" });
    widget.update();

    // Should render as completed, not active
    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("✔");
    expect(lines[1]).toContain("~~#1 Task~~");
  });

  it("supports multiple active tasks simultaneously", () => {
    store.create("Task A", "Desc", "Processing A");
    store.create("Task B", "Desc", "Processing B");
    store.update("1", { status: "in_progress" });
    store.update("2", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.setActiveTask("2", true);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Processing A…");
    expect(lines[2]).toContain("Processing B…");
  });

  it("distributes token usage across all active tasks", () => {
    store.create("Task A", "Desc", "A");
    store.create("Task B", "Desc", "B");
    store.update("1", { status: "in_progress" });
    store.update("2", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.setActiveTask("2", true);

    widget.addTokenUsage(100, 50);

    const lines = renderWidget(ui.state);
    // Both tasks should have the same token counts
    expect(lines[1]).toContain("↑ 100");
    expect(lines[2]).toContain("↑ 100");
  });

  it("dispose clears widget and timer", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.dispose();
    expect(ui.state.widgets.get("tasks")?.content).toBeUndefined();
  });

  it("uses subject as fallback when no activeForm", () => {
    store.create("My Subject", "Desc");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("My Subject…");
  });

  it("shows elapsed time but no token arrows when tokens are zero", () => {
    store.create("No tokens", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    // No addTokenUsage calls — tokens stay at 0
    vi.advanceTimersByTime(5000);
    widget.update();

    const lines = renderWidget(ui.state);
    const activeLine = lines.find(l => l.includes("Working…"));
    expect(activeLine).toContain("5s");
    expect(activeLine).not.toContain("↑");
    expect(activeLine).not.toContain("↓");
  });

  it("cleans up metrics when stale active IDs are pruned", () => {
    store.create("Task", "Desc", "Running");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.addTokenUsage(100, 50);

    // Delete task externally
    store.update("1", { status: "deleted" });
    widget.update();

    // Reactivate with same ID (new task) — should get fresh metrics
    store.create("Task 2", "Desc", "Running");  // ID 2
    store.update("2", { status: "in_progress" });
    widget.setActiveTask("2", true);

    const lines = renderWidget(ui.state);
    // Should not carry over old tokens
    expect(lines[1]).not.toContain("↑ 100");
  });

  it("indents task lines under header", () => {
    store.create("Indented task", "Desc");
    widget.update();

    const lines = renderWidget(ui.state);
    // Task line should start with 2 spaces
    expect(lines[1]).toMatch(/^\s{2}/);
  });

  it("widget is placed aboveEditor", () => {
    store.create("Task", "Desc");
    widget.update();

    const entry = ui.state.widgets.get("tasks");
    expect(entry?.options?.placement).toBe("aboveEditor");
  });
});

describe("formatDuration (via widget rendering)", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TaskStore();
    widget = new TaskWidget(store);
    ui = mockUICtx();
    widget.setUICtx(ui.ctx);
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  it("shows seconds for short durations", () => {
    store.create("Quick", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(30_000); // 30s
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("30s");
  });

  it("shows hours for long durations", () => {
    store.create("Long", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(3_723_000); // 1h 2m 3s → "1h 2m"
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("1h 2m");
  });

  it("shows exact hours without minutes", () => {
    store.create("Exact", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(7_200_000); // 2h exactly
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("2h)");
  });

  it("shows minutes and seconds", () => {
    store.create("Medium", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(169_000); // 2m 49s
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("2m 49s");
  });

  it("formats small token counts without k suffix", () => {
    store.create("Small", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.addTokenUsage(500, 200);
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("↑ 500");
    expect(lines[1]).toContain("↓ 200");
  });

  it("formats token counts with k suffix and removes .0", () => {
    store.create("Large", "Desc", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.addTokenUsage(2000, 4100);
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("↑ 2k");    // 2000 → "2k" (not "2.0k")
    expect(lines[1]).toContain("↓ 4.1k");  // 4100 → "4.1k"
  });
});

describe("configurable glyphs", () => {
  let store: TaskStore;
  let ui: ReturnType<typeof mockUICtx>;
  let widget: TaskWidget;

  /** Build a widget over the given glyph config and seed one task per status. */
  function seed(glyphs: TasksConfig["glyphs"], config: TasksConfig = {}) {
    store = new TaskStore();
    ui = mockUICtx();
    widget = new TaskWidget(store, { ...config, glyphs });
    widget.setUICtx(ui.ctx);
    store.create("Done task", "Desc");
    store.create("Open task", "Desc");
    store.create("Running task", "Desc", "Running");
    store.update("1", { status: "completed" });
    store.update("3", { status: "in_progress" });
    widget.update();
    return renderWidget(ui.state);
  }

  /** Render one over-long task at a 20-column terminal, ANSI stripped — truncateToWidth
   *  wraps its marker in reset codes, and the mock theme adds none of its own. */
  function clippedAt20(glyphs: TasksConfig["glyphs"]) {
    store = new TaskStore();
    ui = mockUICtx();
    widget = new TaskWidget(store, { glyphs });
    widget.setUICtx(ui.ctx);
    store.create("A subject far too long for this terminal", "Desc");
    widget.update();

    return renderWidget(ui.state, 20)[1].replace(/\u001b\[[0-9;]*m/g, "");
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  it("renders the default glyphs when none are configured", () => {
    const lines = seed(undefined);

    expect(lines[0]).toContain("●");
    expect(lines[1]).toContain("✔");
    expect(lines[2]).toContain("◻");
    expect(lines[3]).toContain("◼");
  });

  it("renders configured status glyphs", () => {
    const lines = seed({ completed: "[x]", pending: "[ ]", inProgress: "[>]" });

    expect(lines[1]).toContain("[x] ~~#1 Done task~~");
    expect(lines[2]).toContain("[ ] #2 Open task");
    expect(lines[3]).toContain("[>] #3 Running task");
  });

  it("renders a configured header glyph", () => {
    expect(seed({ header: "▸" })[0]).toContain("▸ 3 tasks");
  });

  it("follows the completed glyph on the collapsed count line", () => {
    const lines = seed({ completed: "[x]" }, { collapseCompleted: true });

    expect(lines[lines.length - 1]).toContain("[x] 1 completed");
  });

  it("prefers an explicit completedSummary on the collapsed count line", () => {
    const lines = seed({ completed: "[x]", completedSummary: "[=]" }, { collapseCompleted: true });

    expect(lines[lines.length - 1]).toContain("[=] 1 completed");
    expect(lines.some(l => l.includes("[x]"))).toBe(false);
  });

  it("cycles the configured spinner frames on the active task", () => {
    seed({ spinner: ["<", "^", ">", "v"] });
    widget.setActiveTask("3");

    const frames: string[] = [];
    for (let i = 0; i < 5; i++) {
      frames.push(renderWidget(ui.state)[3].trim().split(" ")[0]);
      vi.advanceTimersByTime(150);
    }

    expect(frames).toEqual(["<", "^", ">", "v", "<"]);
  });

  it("renders a multi-glyph spinner frame whole", () => {
    seed({ spinner: ["⣾⣾", "⣽⣽"] });
    widget.setActiveTask("3");

    expect(renderWidget(ui.state)[3]).toContain("⣾⣾ #3");
  });

  it("renders a configured overflow glyph", () => {
    const lines = seed({ overflow: "~" }, { maxVisible: 2 });

    expect(lines[lines.length - 1]).toContain("~ and 1 more");
  });

  it("renders a configured blocked glyph", () => {
    seed({ blocked: "->" });
    store.update("2", { addBlockedBy: ["3"] });
    widget.update();

    const blockedLine = renderWidget(ui.state).find(l => l.includes("Open task"));
    expect(blockedLine).toContain("-> blocked by #3");
  });

  it("renders configured token, separator and trailing glyphs on the active row", () => {
    seed({ inputTokens: "in", outputTokens: "out", statsSeparator: "|", trailingEllipsis: "~~" });
    widget.setActiveTask("3");
    widget.addTokenUsage(1500, 800);
    vi.advanceTimersByTime(5_000);
    widget.update();

    const activeLine = renderWidget(ui.state)[3];
    expect(activeLine).toContain("Running~~");
    expect(activeLine).toContain("(5s | in 1.5k out 800)");
  });

  // Asserted by shape, not by exact string: where pi-tui puts the cut is its
  // arithmetic, not the widget's contract.
  it("clips over-wide lines with the configured truncation glyph", () => {
    const line = clippedAt20({ truncation: "…" });

    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(20);
    expect(line).not.toContain("terminal");
  });

  it("clips with three ASCII dots by default", () => {
    const line = clippedAt20(undefined);

    expect(line.endsWith("...")).toBe(true);
    expect(line).not.toContain("…");
  });

  it("falls back to the defaults for unusable glyph values", () => {
    const glyphs = { completed: "", pending: 3, header: null, spinner: [] } as unknown as TasksConfig["glyphs"];
    const lines = seed(glyphs);
    widget.setActiveTask("3");

    expect(lines[0]).toContain("●");
    expect(lines[1]).toContain("✔");
    expect(lines[2]).toContain("◻");
    expect(renderWidget(ui.state)[3].trim().split(" ")[0]).toBe("✳");
  });

  it("never lets a glyph carry a control character into a rendered line", () => {
    // The threat model is a tasks-config.json that arrived with a cloned repository:
    // the newline would split a widget line in two, the OSC sequence would retitle
    // the terminal. Both fall back, like any other unusable glyph.
    const lines = seed({ pending: "X\n\u001b]0;pwned\u0007" });

    expect(lines[2]).toContain("◻ #2 Open task");
    expect(lines.join("")).not.toMatch(/\p{Cc}/u);
  });
});

describe("spinner animation timing", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TaskStore();
    widget = new TaskWidget(store);
    ui = mockUICtx();
    widget.setUICtx(ui.ctx);
    store.create("Long job", "d", "Working");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1");
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  /** The spinner glyph is the first non-space character of the task line. */
  const glyph = () => renderWidget(ui.state)[1].trim().split(" ")[0];

  it("advances one frame per timer tick", () => {
    const frames = [glyph()];
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(150);
      frames.push(glyph());
    }
    // Four consecutive, distinct frames.
    expect(new Set(frames).size).toBe(4);
  });

  it("does not advance when task activity redraws the widget", () => {
    // update() runs on every task mutation and on tool execution. Advancing the
    // frame there tied animation speed to how busy the agent was, so the spinner
    // raced ahead during bursts and stalled when nothing happened.
    const before = glyph();
    for (let i = 0; i < 5; i++) widget.update();

    expect(glyph()).toBe(before);
  });

  it("still animates after an unrelated redraw", () => {
    widget.update();
    const before = glyph();
    vi.advanceTimersByTime(150);

    expect(glyph()).not.toBe(before);
  });
});
