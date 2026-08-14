import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStore } from "../src/task-store.js";
import { loadTasksConfig } from "../src/tasks-config.js";
import type { TaskComparator } from "../src/types.js";
import { TaskWidget, type Theme, type UICtx } from "../src/ui/task-widget.js";

const temporaryDirectories: string[] = [];

function activeFirstComparator(): TaskComparator {
  return (a, b) => {
    const rank = { in_progress: 0, pending: 1, completed: 2 };
    return rank[a.status] - rank[b.status] || Number(a.id) - Number(b.id);
  };
}

function render(store: TaskStore): string[] {
  let content: Parameters<UICtx["setWidget"]>[1];
  const ui: UICtx = {
    setStatus() {},
    setWidget(_key, value) { content = value; },
  };
  const widget = new TaskWidget(store, { collapseCompleted: true, sortOrder: activeFirstComparator() });
  widget.setUICtx(ui);
  widget.update();
  const theme: Theme = {
    fg: (_color, text) => text,
    bold: text => text,
    strikethrough: text => text,
  };
  const component = content!({ terminal: { columns: 200 }, requestRender() {} }, theme);
  const lines = component.render();
  widget.dispose();
  return lines;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("custom task sorting", () => {
  it("accepts a comparator without changing built-in status ordering", () => {
    const store = new TaskStore();
    store.create("Pending", "");
    store.create("Completed", "");
    store.create("In progress", "");
    store.update("2", { status: "completed" });
    store.update("3", { status: "in_progress" });

    expect(store.list("status").map(task => task.subject)).toEqual(["Completed", "In progress", "Pending"]);
    expect(store.list(activeFirstComparator()).map(task => task.subject)).toEqual(["In progress", "Pending", "Completed"]);
  });

  it("loads a comparator from tasks-config.cjs", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-tasks-custom-sort-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "tasks-config.json"), JSON.stringify({ collapseCompleted: true }));
    writeFileSync(join(agentDir, "tasks-config.cjs"), `module.exports = {
      sortOrder: (a, b) => ({ in_progress: 0, pending: 1, completed: 2 }[a.status] - { in_progress: 0, pending: 1, completed: 2 }[b.status])
    };`);

    const config = loadTasksConfig(cwd, agentDir);
    expect(config.collapseCompleted).toBe(true);
    expect(typeof config.sortOrder).toBe("function");
  });

  it("shows all active tasks and one completed count when enabled", () => {
    const store = new TaskStore();
    for (let index = 1; index <= 12; index++) store.create(`Open ${index}`, "");
    store.create("Done 1", "");
    store.create("Done 2", "");
    store.create("Working", "");
    store.update("13", { status: "completed" });
    store.update("14", { status: "completed" });
    store.update("15", { status: "in_progress" });

    const lines = render(store);
    expect(lines[1]).toContain("Working");
    expect(lines.filter(line => line.includes("Open "))).toHaveLength(12);
    expect(lines.at(-1)).toContain("2 completed tasks");
    expect(lines.some(line => line.includes("more"))).toBe(false);
  });
});
