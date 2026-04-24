import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessTracker } from "../src/process-tracker.js";
import { TaskStore } from "../src/task-store.js";
import { TaskWidget } from "../src/ui/task-widget.js";

function mockUICtx() {
  const state: { render?: (width?: number) => string[] } = {};
  return {
    state,
    ctx: {
      setStatus: () => {},
      setWidget: (_key: string, content: any) => {
        if (!content) {
          state.render = undefined;
          return;
        }
        state.render = (width = 120) => {
          const tui = { terminal: { columns: width }, requestRender: () => {} };
          const theme = {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
            strikethrough: (text: string) => `~~${text}~~`,
          };
          return content(tui, theme).render();
        };
      },
    },
  };
}

describe("PR #2 port coverage", () => {
  describe("TaskStore", () => {
    let store: TaskStore;

    beforeEach(() => {
      store = new TaskStore();
    });

    it("supports skipped status and clears skipped tasks", () => {
      store.create("Done", "desc");
      store.create("Skip", "desc");
      store.update("1", { status: "completed" });
      store.update("2", { status: "skipped" });

      expect(store.clearCompleted()).toBe(2);
      expect(store.list()).toEqual([]);
    });

    it("creates tasks with initial status", () => {
      const task = store.create("Start now", "desc", undefined, undefined, { status: "in_progress" });
      expect(task.status).toBe("in_progress");
    });

    it("detects transitive dependency cycles", () => {
      store.create("A", "desc");
      store.create("B", "desc");
      store.create("C", "desc");
      store.update("1", { addBlocks: ["2"] });
      store.update("2", { addBlocks: ["3"] });
      const result = store.update("3", { addBlocks: ["1"] });
      expect(result.warnings.some(w => w.includes("cycle"))).toBe(true);
    });
  });

  describe("ProcessTracker", () => {
    let tracker: ProcessTracker;

    beforeEach(() => {
      tracker = new ProcessTracker();
    });

    afterEach(() => {
      tracker.dispose();
    });

    it("removes completed processes", () => {
      const proc = {
        pid: 1,
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, cb: (...args: any[]) => void) => {
          if (event === "close") setTimeout(() => cb(0, undefined), 0);
        },
        kill: () => true,
      } as any;

      tracker.track("1", proc, "fake");
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(tracker.remove("1")).toBe(true);
          resolve();
        }, 10);
      });
    });
  });

  describe("TaskWidget", () => {
    let store: TaskStore;
    let widget: TaskWidget;
    let ui: ReturnType<typeof mockUICtx>;

    beforeEach(() => {
      vi.useFakeTimers();
      store = new TaskStore();
      widget = new TaskWidget(store);
      ui = mockUICtx();
      widget.setUICtx(ui.ctx as any);
    });

    afterEach(() => {
      widget.dispose();
      vi.useRealTimers();
    });

    it("renders skipped tasks", () => {
      store.create("Skip me", "desc");
      store.update("1", { status: "skipped" });
      widget.update();
      const lines = ui.state.render?.() ?? [];
      expect(lines.some(line => line.includes("⊘") && line.includes("Skip me"))).toBe(true);
    });

    it("shows budget information for active tasks", () => {
      store.create("Budgeted", "desc", "Working");
      store.update("1", { status: "in_progress" });
      widget.setActiveTask("1", true);
      widget.setBudget("1", {
        startedAt: Date.now(),
        tokenBudget: 1000,
        tokensUsed: 250,
        timeoutMs: 120000,
      });
      widget.update();
      const lines = ui.state.render?.() ?? [];
      expect(lines.some(line => line.includes("budget") || line.includes("left"))).toBe(true);
    });
  });
});
