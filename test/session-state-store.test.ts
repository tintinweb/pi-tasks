import { describe, expect, it } from "vitest";
import { buildTaskSessionStateDetails, reconstructSessionStateStore, SessionStateTaskStore, TASKS_SESSION_STATE_TYPE } from "../src/session-state-store.js";

describe("SessionStateTaskStore", () => {
  it("creates and updates tasks in memory", () => {
    const store = new SessionStateTaskStore();
    const task = store.create("Task", "Desc");

    expect(task.id).toBe("1");
    store.update("1", { status: "completed" });
    expect(store.get("1")?.status).toBe("completed");
  });

  it("exports and replaces state", () => {
    const store = new SessionStateTaskStore();
    store.create("One", "Desc");

    const snapshot = store.getState();
    const restored = new SessionStateTaskStore();
    restored.replaceState(snapshot);

    expect(restored.list()).toHaveLength(1);
    expect(restored.get("1")?.subject).toBe("One");
  });

  it("builds backend-tagged details", () => {
    const store = new SessionStateTaskStore();
    store.create("One", "Desc");

    expect(buildTaskSessionStateDetails(store)).toEqual({
      version: 1,
      backend: "session_state",
      state: store.getState(),
    });
  });

  it("reconstructs from latest tool result details on the current branch", () => {
    const store = new SessionStateTaskStore();
    const earlier = new SessionStateTaskStore();
    earlier.create("Old", "Desc");
    const later = new SessionStateTaskStore();
    later.create("New", "Desc");
    later.update("1", { status: "completed" });

    const ctx = {
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "TaskCreate",
              details: buildTaskSessionStateDetails(earlier),
            },
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "TaskUpdate",
              details: buildTaskSessionStateDetails(later),
            },
          },
        ],
      },
    } as any;

    reconstructSessionStateStore(ctx, store);
    expect(store.get("1")?.subject).toBe("New");
    expect(store.get("1")?.status).toBe("completed");
  });

  it("reconstructs from latest custom entry for non-tool mutations", () => {
    const store = new SessionStateTaskStore();
    const state = new SessionStateTaskStore();
    state.create("Custom", "Desc");

    const ctx = {
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: TASKS_SESSION_STATE_TYPE,
            data: buildTaskSessionStateDetails(state),
          },
        ],
      },
    } as any;

    reconstructSessionStateStore(ctx, store);
    expect(store.list()).toHaveLength(1);
    expect(store.get("1")?.subject).toBe("Custom");
  });

  it("ignores unrelated tool results and custom entries", () => {
    const store = new SessionStateTaskStore();

    const ctx = {
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "read",
              details: { hello: "world" },
            },
          },
          {
            type: "custom",
            customType: "other-extension",
            data: { value: 1 },
          },
        ],
      },
    } as any;

    reconstructSessionStateStore(ctx, store);
    expect(store.list()).toEqual([]);
    expect(store.getState().nextId).toBe(1);
  });
});
