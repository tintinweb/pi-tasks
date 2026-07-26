import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";
import { TaskWidget, type Theme, type UICtx } from "../src/ui/task-widget.js";

/** Create a mock theme that returns raw text (no ANSI escapes). */
function mockTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    strikethrough: (text: string) => `~~${text}~~`,
  };
}

type MockUI = ReturnType<typeof mockUICtx>;

/** Create a mock UICtx that exposes only observable widget registration behavior. */
function mockUICtx(toolsExpanded = false) {
  const requestRender = vi.fn();
  const state: {
    widgets: Map<string, any>;
    statuses: Map<string, string | undefined>;
    toolsExpanded: boolean;
  } = {
    widgets: new Map(),
    statuses: new Map(),
    toolsExpanded,
  };
  const setWidget = vi.fn((key: string, content: any, options?: { placement?: "aboveEditor" | "belowEditor" }) => {
    state.widgets.set(key, { content, options });
  });

  const ctx: UICtx = {
    setWidget,
    setStatus(key, text) {
      state.statuses.set(key, text);
    },
    getToolsExpanded() {
      return state.toolsExpanded;
    },
  };

  return { ctx, state, requestRender, setWidget };
}

/** Render the currently registered widget and return its lines. */
function renderWidget(ui: MockUI): string[] {
  const entry = ui.state.widgets.get("tasks");
  if (!entry?.content) return [];
  const tui = { terminal: { columns: 200 }, requestRender: ui.requestRender };
  return entry.content(tui, mockTheme()).render();
}

function activeIcon(lines: string[]): string {
  return lines.slice(1).map(line => line.trimStart().split(" ")[0])[0] ?? "";
}

describe("TaskWidget UI context handoff", () => {
  let store: TaskStore;
  let widget: TaskWidget;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TaskStore();
    widget = new TaskWidget(store, { maxVisible: 3 });
  });

  afterEach(() => {
    widget.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not re-register or lose the cached TUI for the same context", () => {
    const ui = mockUICtx();
    widget.setUICtx(ui.ctx);
    store.create("Task", "Desc");
    widget.update();
    renderWidget(ui); // Cache the TUI used by the registered widget.

    ui.setWidget.mockClear();
    ui.requestRender.mockClear();
    widget.setUICtx(ui.ctx);

    expect(ui.setWidget).not.toHaveBeenCalled();
    widget.update();
    expect(ui.setWidget).not.toHaveBeenCalled();
    expect(ui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("hands an active widget to a new context without losing state or rendering stale UI", () => {
    const firstUI = mockUICtx(false);
    widget.setUICtx(firstUI.ctx);
    for (let id = 1; id <= 5; id++) store.create(`Task ${id}`, "Desc");
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.addTokenUsage(1200, 300);

    const initialFrame = activeIcon(renderWidget(firstUI));
    vi.advanceTimersByTime(1000);
    const frameBeforeSwitch = activeIcon(renderWidget(firstUI));
    expect(frameBeforeSwitch).not.toBe(initialFrame);
    expect(renderWidget(firstUI)[1]).toContain("↑ 1.2k");
    expect(renderWidget(firstUI)[1]).toContain("↓ 300");

    firstUI.requestRender.mockClear();
    const secondUI = mockUICtx(true);
    widget.setUICtx(secondUI.ctx);

    expect(firstUI.state.widgets.get("tasks")?.content).toBeUndefined();
    expect(firstUI.setWidget).toHaveBeenLastCalledWith("tasks", undefined);
    expect(secondUI.setWidget).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    // Re-register in the new context without resetting animation or metrics.
    widget.update();
    expect(secondUI.setWidget).toHaveBeenCalledTimes(1);
    const expandedLines = renderWidget(secondUI);
    expect(expandedLines).toHaveLength(6); // header + all five tasks
    expect(activeIcon(expandedLines)).not.toBe(initialFrame);
    expect(expandedLines[1]).toContain("↑ 1.2k");
    expect(expandedLines[1]).toContain("↓ 300");
    expect(expandedLines.join("\n")).not.toContain("earlier");
    expect(expandedLines.join("\n")).not.toContain("later");

    // Timer-driven renders use the new TUI, never the stale old one.
    secondUI.requestRender.mockClear();
    vi.advanceTimersByTime(150);
    expect(firstUI.requestRender).not.toHaveBeenCalled();
    expect(secondUI.requestRender).toHaveBeenCalled();
    const postTickLines = renderWidget(secondUI);
    expect(activeIcon(postTickLines)).not.toBe(frameBeforeSwitch);
    expect(postTickLines[1]).toContain("1s");
    expect(postTickLines[1]).toContain("↑ 1.2k");
    expect(postTickLines[1]).toContain("↓ 300");

    // getToolsExpanded is read at render time, so collapse returns to the focused window.
    secondUI.state.toolsExpanded = false;
    expect(renderWidget(secondUI)).toHaveLength(5); // header + three tasks + later marker
    expect(vi.getTimerCount()).toBe(1);

    widget.dispose();
    expect(secondUI.state.widgets.get("tasks")?.content).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
