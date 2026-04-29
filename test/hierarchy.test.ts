import { describe, expect, it } from "vitest";
import { buildTaskHierarchy, flattenTaskHierarchy } from "../src/hierarchy.js";
import { TaskStore } from "../src/task-store.js";

describe("task hierarchy", () => {
  it("formats nested connector prefixes", () => {
    const store = new TaskStore();
    store.createMany([
      { key: "root", subject: "Root", description: "Desc" },
      { key: "first", subject: "First", description: "Desc", relations: [{ type: "parent", target: "root" }] },
      { key: "grandchild", subject: "Grandchild", description: "Desc", relations: [{ type: "parent", target: "first" }] },
      { key: "second", subject: "Second", description: "Desc", relations: [{ type: "parent", target: "root" }] },
    ]);

    const rows = flattenTaskHierarchy(buildTaskHierarchy(store.list()));

    expect(rows.map(row => `${row.connectorPrefix}#${row.task.id}`)).toEqual([
      "#1",
      "├─ #2",
      "│  └─ #3",
      "└─ #4",
    ]);
  });
});
