/**
 * Tests for task-subagent integration: TaskExecute tool, completion listener,
 * auto-cascade, and widget agent ID display.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { TaskStore } from "../src/task-store.js";
import { TaskWidget, type Theme, type UICtx } from "../src/ui/task-widget.js";
import { installSubagentsMock, type MockEventBus, mockCtx, mockPi, mockSessionCtx } from "./helpers/mock-pi.js";

// Config is mocked rather than written to <cwd>/.pi/tasks-config.json: writing the
// real file would clobber the user's project settings, and reading it would let the
// developer's global <agentDir>/tasks-config.json leak into the results.
const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/tasks-config.js", () => ({
  loadGlobalTasksConfig: () => ({ ...config.current }),
  loadTasksConfig: () => ({ ...config.current }),
  saveTasksConfig: () => {},
}));

// Force in-memory task store for all integration tests — prevents file-backed
// store from loading stale tasks across test instances.
beforeEach(() => {
  process.env.PI_TASKS = "off";
  config.current = {};
});
afterEach(() => { delete process.env.PI_TASKS; });

describe("Session task rehydration", () => {
  // Task paths resolve against the session workspace (ctx.cwd), so every test gets
  // its own: .pi/ in the real working directory holds the developer's own task list.
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-tasks-session-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  const sessionCtx = (sessionId: string) => mockSessionCtx(sessionId, { cwd });
  const sessionFile = (sessionId: string) => join(cwd, ".pi", "tasks", `tasks-${sessionId}.json`);

  it("renders default session-scoped tasks immediately after reload", async () => {
    const sessionId = `reload-${process.pid}-${Date.now()}`;
    const taskFile = sessionFile(sessionId);
    try {
      new TaskStore(taskFile).create("Review the rerun", "Inspect final results");
      delete process.env.PI_TASKS;
      const mock = mockPi();
      initExtension(mock.pi as any);
      const ctx = sessionCtx(sessionId);

      await mock.fireLifecycle("session_start", { reason: "reload" }, ctx);

      expect(ctx.sessionManager.getSessionId).toHaveBeenCalledOnce();
      expect(ctx.ui.setWidget).toHaveBeenCalledWith("tasks", expect.any(Function), {
        placement: "aboveEditor",
      });
    } finally {
      rmSync(taskFile, { force: true });
    }
  });

  it("renders tasks from a PI_TASKS path override after reload", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-tasks-reload-"));
    const taskFile = join(directory, "tasks.json");
    try {
      new TaskStore(taskFile).create("Review the rerun", "Inspect final results");
      process.env.PI_TASKS = taskFile;
      const mock = mockPi();
      initExtension(mock.pi as any);
      const ctx = mockCtx(cwd);

      await mock.fireLifecycle("session_start", { reason: "reload" }, ctx);

      expect(ctx.ui.setWidget).toHaveBeenCalledWith("tasks", expect.any(Function), {
        placement: "aboveEditor",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("renders persisted tasks after /resume", async () => {
    const sessionId = `resume-${process.pid}-${Date.now()}`;
    const taskFile = sessionFile(sessionId);
    try {
      new TaskStore(taskFile).create("Resume this", "Pick up where we left off");
      delete process.env.PI_TASKS;
      const mock = mockPi();
      initExtension(mock.pi as any);
      const ctx = sessionCtx(sessionId);

      await mock.fireLifecycle("session_start", { reason: "resume" }, ctx);

      expect(ctx.ui.setWidget).toHaveBeenCalledWith("tasks", expect.any(Function), {
        placement: "aboveEditor",
      });
    } finally {
      rmSync(taskFile, { force: true });
    }
  });

  it("switches the session-scoped store to the new session on /new", async () => {
    const sessionA = `switch-a-${process.pid}-${Date.now()}`;
    const sessionB = `switch-b-${process.pid}-${Date.now()}`;
    const fileA = sessionFile(sessionA);
    const fileB = sessionFile(sessionB);
    try {
      new TaskStore(fileA).create("Task in A", "desc");
      new TaskStore(fileB).create("Task in B", "desc");
      delete process.env.PI_TASKS;
      const mock = mockPi();
      initExtension(mock.pi as any);

      const ctxA = sessionCtx(sessionA);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctxA);
      expect(ctxA.sessionManager.getSessionId).toHaveBeenCalledOnce();

      // /new must re-point at the new session file. This was previously handled
      // by the never-emitted session_switch event, leaving the store on session A.
      const ctxB = sessionCtx(sessionB);
      await mock.fireLifecycle("session_start", { reason: "new" }, ctxB);
      expect(ctxB.sessionManager.getSessionId).toHaveBeenCalledOnce();
    } finally {
      rmSync(fileA, { force: true });
      rmSync(fileB, { force: true });
    }
  });

  it("seeds a forked session with an independent copy of the parent's tasks", async () => {
    const parent = `fork-parent-${process.pid}-${Date.now()}`;
    const child = `fork-child-${process.pid}-${Date.now()}`;
    const parentFile = sessionFile(parent);
    const childFile = sessionFile(child);
    try {
      new TaskStore(parentFile).create("Inherited task", "carry me into the fork");
      delete process.env.PI_TASKS;
      const mock = mockPi();
      initExtension(mock.pi as any);

      const ctxP = sessionCtx(parent);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctxP);

      // /fork re-points to a brand-new (empty) session file. Without seeding, the
      // fork would silently lose the parent's tasks; with it, the fork gets an
      // independent copy that does not write back to the parent.
      const ctxC = sessionCtx(child);
      await mock.fireLifecycle("session_start", { reason: "fork" }, ctxC);

      const forked = new TaskStore(childFile).list();
      expect(forked.map(t => t.subject)).toEqual(["Inherited task"]);

      // The fork is independent — mutating it must not touch the parent's file.
      new TaskStore(childFile).create("Fork-only task", "not in parent");
      expect(new TaskStore(parentFile).list().map(t => t.subject)).toEqual(["Inherited task"]);
    } finally {
      rmSync(parentFile, { force: true });
      rmSync(childFile, { force: true });
    }
  });
});

describe("Workspace-scoped store resolution", () => {
  // Paths come from ExtensionContext.cwd, not process.cwd(). The two match in the
  // terminal host, but a long-lived host serving sessions from another directory
  // would otherwise write every workspace's tasks into its own.
  const workspaces: string[] = [];
  const workspace = (label: string) => {
    const dir = mkdtempSync(join(tmpdir(), `pi-tasks-${label}-`));
    workspaces.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("stores session tasks under ctx.cwd instead of the host process cwd", async () => {
    const cwd = workspace("workspace");
    const sessionId = `ctx-cwd-${process.pid}-${Date.now()}`;
    const taskFile = join(cwd, ".pi", "tasks", `tasks-${sessionId}.json`);
    const hostTaskFile = join(process.cwd(), ".pi", "tasks", `tasks-${sessionId}.json`);
    delete process.env.PI_TASKS;
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = mockSessionCtx(sessionId, { cwd });

    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("TaskCreate", {
      subject: "Workspace task",
      description: "Must use the session workspace",
    }, ctx);

    expect(new TaskStore(taskFile).list().map(t => t.subject)).toEqual(["Workspace task"]);
    expect(existsSync(hostTaskFile)).toBe(false);
  });

  it("loads project scope from ctx.cwd and stores the shared task list there", async () => {
    const cwd = workspace("project-scope");
    config.current = { taskScope: "project" };
    delete process.env.PI_TASKS;
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = mockCtx(cwd);

    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("TaskCreate", {
      subject: "Shared workspace task",
      description: "Must use the project-scoped store",
    }, ctx);

    const taskFile = join(cwd, ".pi", "tasks", "tasks.json");
    expect(new TaskStore(taskFile).list().map(t => t.subject)).toEqual(["Shared workspace task"]);
  });

  it("resolves relative PI_TASKS paths from ctx.cwd", async () => {
    const cwd = workspace("relative");
    process.env.PI_TASKS = "./state/tasks.json";
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = mockCtx(cwd);

    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("TaskCreate", {
      subject: "Relative override task",
      description: "Must resolve relative to the session workspace",
    }, ctx);

    const taskFile = join(cwd, "state", "tasks.json");
    expect(new TaskStore(taskFile).list().map(t => t.subject)).toEqual(["Relative override task"]);
  });

  it("switches session stores when the session ID changes in the same workspace", async () => {
    const cwd = workspace("session-switch");
    const sessionA = `same-cwd-a-${process.pid}-${Date.now()}`;
    const sessionB = `same-cwd-b-${process.pid}-${Date.now()}`;
    delete process.env.PI_TASKS;
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctxA = mockSessionCtx(sessionA, { cwd });
    const ctxB = mockSessionCtx(sessionB, { cwd });

    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxA);
    await mock.executeTool("TaskCreate", { subject: "Task A", description: "Session A" }, ctxA);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxB);
    await mock.executeTool("TaskCreate", { subject: "Task B", description: "Session B" }, ctxB);

    const file = (id: string) => join(cwd, ".pi", "tasks", `tasks-${id}.json`);
    expect(new TaskStore(file(sessionA)).list().map(t => t.subject)).toEqual(["Task A"]);
    expect(new TaskStore(file(sessionB)).list().map(t => t.subject)).toEqual(["Task B"]);
  });

  it("keeps an in-memory store when the context cwd changes", async () => {
    const ctxA = mockCtx(workspace("memory-a"));
    const ctxB = mockCtx(workspace("memory-b"));
    process.env.PI_TASKS = "off";
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxA);
    await mock.executeTool("TaskCreate", { subject: "Memory task", description: "Keep me" }, ctxA);
    await mock.fireLifecycle("turn_start", {}, ctxB);

    const result = await mock.executeTool("TaskList", {}, ctxB);
    expect(result.content[0].text).toContain("Memory task");
  });
});

// ---- Tests ----

describe("TaskExecute", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(() => {
    mock = mockPi();
    // Install mock BEFORE init so ping reply is received during extension init
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
  });

  afterEach(() => {
    rpc.unsub();
  });

  it("is registered as a tool", () => {
    expect(mock.tools.has("TaskExecute")).toBe(true);
  });

  it("returns error when subagent extension is not loaded", async () => {
    // Re-init without mock to simulate missing extension
    const freshMock = mockPi();
    initExtension(freshMock.pi as any);

    await freshMock.executeTool("TaskCreate", {
      subject: "Test task",
      description: "Do something",
      agentType: "general-purpose",
    });

    const result = await freshMock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Subagent execution is currently unavailable");
  });

  it("rejects non-existent tasks", async () => {
    const result = await mock.executeTool("TaskExecute", { task_ids: ["999"] });
    expect(result.content[0].text).toContain("#999: not found");
  });

  it("rejects tasks without agentType", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "No agent type",
      description: "Plain task",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("#1: no agentType set");
  });

  it("rejects non-pending tasks", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Already started",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("#1: not pending");
  });

  it("rejects tasks with unresolved blockers", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Blocker",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Blocked",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["2"] });
    expect(result.content[0].text).toContain("#2: blocked by #1");
  });

  it("spawns agent for valid task and updates metadata", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Run tests",
      description: "Run the test suite",
      agentType: "general-purpose",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Launched 1 agent");
    expect(result.content[0].text).toContain("#1 → agent agent-1");

    // Verify the RPC responder was called
    expect(rpc.spawned).toHaveLength(1);
    expect(rpc.spawned[0].type).toBe("general-purpose");
    expect(rpc.spawned[0].prompt).toContain("Run the test suite");
    expect(rpc.spawned[0].options.isBackground).toBe(true);
  });

  it("passes additional_context and max_turns to spawned agents", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Explore codebase",
      description: "Find all API endpoints",
      agentType: "Explore",
    });

    await mock.executeTool("TaskExecute", {
      task_ids: ["1"],
      additional_context: "Focus on REST endpoints only",
      max_turns: 10,
    });

    expect(rpc.spawned[0].prompt).toContain("Focus on REST endpoints only");
    expect(rpc.spawned[0].options.maxTurns).toBe(10);
  });

  it("allows executing tasks whose blockers are all completed", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Blocker",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Dependent",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["2"] });
    expect(result.content[0].text).toContain("Launched 1 agent");
  });

  it("handles mixed valid and invalid tasks in one call", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Valid",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "No agent type",
      description: "Desc",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1", "2", "999"] });
    const text = result.content[0].text;
    expect(text).toContain("Launched 1 agent");
    expect(text).toContain("#2: no agentType set");
    expect(text).toContain("#999: not found");
  });
});

describe("TaskExecute via ready broadcast", () => {
  it("detects subagents when ready fires after tasks init", async () => {
    // Init tasks WITHOUT the mock — subagents not available yet
    const mock = mockPi();
    initExtension(mock.pi as any);

    // Now install the mock (simulates subagents loading later) and broadcast ready
    const rpc = installSubagentsMock(mock.pi);

    // Create a task and execute — should work because ready was received
    await mock.executeTool("TaskCreate", {
      subject: "Late-loaded test",
      description: "Desc",
      agentType: "general-purpose",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Launched 1 agent");
    expect(rpc.spawned).toHaveLength(1);

    rpc.unsub();
  });
});

describe("Completion listener", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(() => {
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
  });

  afterEach(() => {
    rpc.unsub();
  });

  it("marks task completed on subagents:completed event", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Agent task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    // Simulate agent completion
    mock.emitEvent("subagents:completed", { id: "agent-1" });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: completed");
  });

  it("reverts task to pending on subagents:failed event", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Failing task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    // Simulate agent failure
    mock.emitEvent("subagents:failed", { id: "agent-1", error: "Out of turns", status: "error" });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: pending");
  });

  it("completes the task and keeps the partial result when the agent was stopped", async () => {
    // status "stopped" is an intentional stop, not a failure — the inverse of the
    // error branch above: the task completes and whatever the agent produced is kept.
    await mock.executeTool("TaskCreate", {
      subject: "Stopped task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    mock.emitEvent("subagents:failed", { id: "agent-1", result: "partial work", status: "stopped" });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: completed");
    expect(result.content[0].text).toContain("partial work");
  });

  it("keeps an earlier result when a stopped agent reports none", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Stopped task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    await mock.executeTool("TaskUpdate", { taskId: "1", metadata: { result: "earlier output" } });

    mock.emitEvent("subagents:failed", { id: "agent-1", status: "stopped" });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: completed");
    expect(result.content[0].text).toContain("earlier output");
  });

  it("ignores events for unknown agent IDs", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Unrelated",
      description: "Desc",
    });

    // Should not throw or modify anything
    mock.emitEvent("subagents:completed", { id: "unknown-agent" });
    mock.emitEvent("subagents:failed", { id: "unknown-agent", error: "boom", status: "error" });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Status: pending");
  });
});

describe("Auto-cascade", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(() => {
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
  });

  afterEach(() => {
    rpc.unsub();
  });

  it("does NOT cascade when auto-cascade is off (default)", async () => {
    // Create A → B chain
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    // Execute A
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(rpc.spawned).toHaveLength(1);

    // Complete A
    mock.emitEvent("subagents:completed", { id: "agent-1" });

    // B should NOT have been auto-started
    expect(rpc.spawned).toHaveLength(1);

    // B should still be pending
    const result = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(result.content[0].text).toContain("Status: pending");
  });

  it("does NOT cascade on failure (branch stops)", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    mock.emitEvent("subagents:failed", { id: "agent-1", error: "crashed", status: "error" });

    // B should not start
    expect(rpc.spawned).toHaveLength(1);
    const result = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(result.content[0].text).toContain("Status: pending");
  });

  it("tasks without agentType are not cascaded even if unblocked", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Agent task",
      description: "Desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Manual task",
      description: "Desc",
      // No agentType — manual
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    mock.emitEvent("subagents:completed", { id: "agent-1" });

    // Manual task should stay pending
    expect(rpc.spawned).toHaveLength(1);
  });
});


describe("Standalone operation (no subagents extension)", () => {
  let mock: ReturnType<typeof mockPi>;

  beforeEach(() => {
    // Init WITHOUT installSubagentsMock — no subagents extension present
    mock = mockPi();
    initExtension(mock.pi as any);
  });

  it("all core task tools are registered", () => {
    for (const name of ["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskExecute"]) {
      expect(mock.tools.has(name)).toBe(true);
    }
  });

  it("TaskCreate works without subagents", async () => {
    const result = await mock.executeTool("TaskCreate", {
      subject: "Write tests",
      description: "Add unit tests for the parser",
    });
    expect(result.content[0].text).toContain("Write tests");
  });

  it("TaskList works without subagents", async () => {
    await mock.executeTool("TaskCreate", { subject: "A", description: "desc" });
    await mock.executeTool("TaskCreate", { subject: "B", description: "desc" });
    const result = await mock.executeTool("TaskList", {});
    expect(result.content[0].text).toContain("#1");
    expect(result.content[0].text).toContain("#2");
  });

  it("TaskGet works without subagents", async () => {
    await mock.executeTool("TaskCreate", { subject: "Read me", description: "details here" });
    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("Read me");
    expect(result.content[0].text).toContain("details here");
  });

  it("TaskUpdate works without subagents", async () => {
    await mock.executeTool("TaskCreate", { subject: "Update me", description: "desc" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });
    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("in_progress");
  });

  it("TaskExecute gracefully refuses without subagents", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Agent task",
      description: "desc",
      agentType: "general-purpose",
    });
    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    const text = result.content[0].text;
    expect(text).toContain("Subagent execution is currently unavailable");
    // Offers the plain Agent tool as a fallback, with the tracking caveat.
    expect(text).toContain("Agent-tool spawns");
    expect(text).toContain("won't track them");
  });

  it("subagents lifecycle events are silently ignored without mapped agents", () => {
    // These should not throw even though no subagents extension is loaded
    mock.emitEvent("subagents:completed", { id: "ghost-agent", result: "done" });
    mock.emitEvent("subagents:failed", { id: "ghost-agent", error: "boom", status: "error" });
    // No crash = pass
  });

  it("task dependencies work without subagents", async () => {
    await mock.executeTool("TaskCreate", { subject: "First", description: "desc" });
    await mock.executeTool("TaskCreate", { subject: "Second", description: "desc" });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    const result = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(result.content[0].text).toContain("Blocked by");
    expect(result.content[0].text).toContain("#1");
  });
});

describe("RPC protocol correctness", () => {
  it("ping uses scoped reply channel (not shared channel)", () => {
    const mock = mockPi();
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const origEmit = mock.pi.events.emit.bind(mock.pi.events);
    mock.pi.events.emit = (channel: string, data: unknown) => {
      emitted.push({ channel, data });
      origEmit(channel, data);
    };

    initExtension(mock.pi as any);

    // Find the ping emit
    const pingEmit = emitted.find(e => e.channel === "subagents:rpc:ping");
    expect(pingEmit).toBeDefined();
    const pingData = pingEmit!.data as { requestId: string };
    expect(pingData.requestId).toBeDefined();
    expect(typeof pingData.requestId).toBe("string");
  });

  it("spawn reply cleans up listener and timer on success", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Test",
      description: "desc",
      agentType: "general-purpose",
    });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(rpc.spawned).toHaveLength(1);

    // Second spawn should get a fresh requestId (not conflict with first)
    await mock.executeTool("TaskCreate", {
      subject: "Test 2",
      description: "desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["2"] });
    expect(rpc.spawned).toHaveLength(2);
    expect(rpc.spawned[0].id).not.toBe(rpc.spawned[1].id);

    rpc.unsub();
  });

  it("spawn RPC rejects on timeout when no responder exists", async () => {
    const mock = mockPi();
    // Install ping handler (for version check) but no spawn handler
    installVersionedMock(mock.pi, 2);
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Timeout test",
      description: "desc",
      agentType: "general-purpose",
    });

    // spawnSubagent has a 30s timeout — we'll advance timers
    vi.useFakeTimers();
    const execPromise = mock.executeTool("TaskExecute", { task_ids: ["1"] });
    await vi.advanceTimersByTimeAsync(31000);

    const result = await execPromise;
    expect(result.content[0].text).toContain("timeout");

    vi.useRealTimers();
  });

  it("ready broadcast sets subagentsAvailable even after init", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    // Initially no subagents
    await mock.executeTool("TaskCreate", {
      subject: "Test",
      description: "desc",
      agentType: "general-purpose",
    });
    let result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Subagent execution is currently unavailable");

    // Reset task status
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "pending" });

    // Late subagents extension broadcasts ready
    const rpc = installSubagentsMock(mock.pi);

    result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Launched 1 agent");

    rpc.unsub();
  });

  it("spawn RPC rejects with error message from server", async () => {
    const mock = mockPi();
    installSubagentsMock(mock.pi, { spawnError: "No active session" });
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Err test",
      description: "desc",
      agentType: "general-purpose",
    });

    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("No active session");
  });

  it("stop RPC resolves on success", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);

    // Spawn a task so we have an agent to stop
    await mock.executeTool("TaskCreate", {
      subject: "Stoppable",
      description: "desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(rpc.spawned).toHaveLength(1);

    const result = await mock.executeTool("TaskStop", { task_id: "1" });
    expect(result.content[0].text).toContain("stopped successfully");
    expect(rpc.stopped).toContain("agent-1");

    rpc.unsub();
  });

  it("stop RPC returns false on error (agent not found) without throwing", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);

    // Create and execute a task, then simulate agent already gone
    await mock.executeTool("TaskCreate", {
      subject: "Ghost",
      description: "desc",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    // Clear spawned list so the mock's stop handler won't find the agent
    rpc.spawned.length = 0;

    // TaskStop should still succeed (stopSubagent catches the error)
    const result = await mock.executeTool("TaskStop", { task_id: "1" });
    expect(result.content[0].text).toContain("stopped successfully");

    rpc.unsub();
  });

  it("stop RPC returns false on timeout without throwing", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    // Mark subagents as available via ready broadcast, but no stop handler installed
    mock.pi.events.emit("subagents:ready", {});

    await mock.executeTool("TaskCreate", {
      subject: "Timeout stop",
      description: "desc",
      agentType: "general-purpose",
    });
    // Manually set task as in_progress with an agentId (no spawn handler)
    await mock.executeTool("TaskUpdate", {
      taskId: "1",
      status: "in_progress",
      metadata: { agentType: "general-purpose", agentId: "ghost-agent" },
    });

    vi.useFakeTimers();
    const stopPromise = mock.executeTool("TaskStop", { task_id: "1" });
    await vi.advanceTimersByTimeAsync(11000);

    // Should resolve (not throw) — stopSubagent catches timeout
    const result = await stopPromise;
    expect(result.content[0].text).toContain("stopped successfully");

    vi.useRealTimers();
  });
});

/** Install a ping-only mock with a specific protocol version (or no version for v1). */
function installVersionedMock(pi: { events: MockEventBus }, version?: number) {
  const unsubPing = pi.events.on("subagents:rpc:ping", (data: unknown) => {
    const { requestId } = data as { requestId: string };
    if (version !== undefined) {
      pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version } });
    } else {
      // v1 handler — no envelope, no version
      pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, {});
    }
  });
  pi.events.emit("subagents:ready", {});
  return { unsub() { unsubPing(); } };
}

describe("Protocol version mismatch", () => {
  it("matching version — no warning", async () => {
    const mock = mockPi();
    installVersionedMock(mock.pi, 2);
    initExtension(mock.pi as any);

    // No warning on before_agent_start
    const ctx = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("old handler (no version) — warns about pi-subagents", async () => {
    const mock = mockPi();
    installVersionedMock(mock.pi);  // no version = v1
    initExtension(mock.pi as any);

    const ctx = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("pi-subagents is outdated"),
      "warning",
    );
  });

  it("handler ahead (v3) — warns about pi-tasks", async () => {
    const mock = mockPi();
    installVersionedMock(mock.pi, 3);
    initExtension(mock.pi as any);

    const ctx = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("pi-tasks is outdated"),
      "warning",
    );
  });

  it("handler behind (v1) — warns about pi-subagents", async () => {
    const mock = mockPi();
    installVersionedMock(mock.pi, 1);
    initExtension(mock.pi as any);

    const ctx = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("pi-subagents is outdated"),
      "warning",
    );
  });

  it("warning shown only once", async () => {
    const mock = mockPi();
    installVersionedMock(mock.pi);  // v1 — triggers warning
    initExtension(mock.pi as any);

    const ctx1 = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx1);
    expect(ctx1.ui.notify).toHaveBeenCalledOnce();

    const ctx2 = mockCtx();
    await mock.fireLifecycle("before_agent_start", {}, ctx2);
    expect(ctx2.ui.notify).not.toHaveBeenCalled();
  });
});

describe("Widget agent ID display", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  function mockUICtx() {
    const state = {
      widgets: new Map<string, any>(),
      statuses: new Map<string, string | undefined>(),
    };
    const ctx: UICtx = {
      setWidget(key, content, options) { state.widgets.set(key, { content, options }); },
      setStatus(key, text) { state.statuses.set(key, text); },
    };
    return { ctx, state };
  }

  function mockTheme(): Theme {
    return {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      strikethrough: (text: string) => `~~${text}~~`,
    };
  }

  function renderWidget(state: ReturnType<typeof mockUICtx>["state"]): string[] {
    const entry = state.widgets.get("tasks");
    if (!entry?.content) return [];
    const theme = mockTheme();
    const tui = { terminal: { columns: 200 } };
    return entry.content(tui, theme).render();
  }

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

  it("shows agent ID for active agent-backed tasks", () => {
    store.create("Agent task", "Desc", "Running tests", { agentType: "general-purpose", agentId: "abc1234567890" });
    store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("agent abc12");
    expect(lines[1]).toContain("Running tests");
  });

  it("shows agent ID for non-active in_progress agent-backed tasks", () => {
    store.create("Agent task", "Desc", undefined, { agentType: "general-purpose", agentId: "xyz9876543210" });
    store.update("1", { status: "in_progress" });
    // NOT calling setActiveTask — simulates external agent management
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("agent xyz98");
    expect(lines[1]).toContain("Agent task");
  });

  it("does not show agent ID for tasks without agentId", () => {
    store.create("Manual task", "Desc");
    store.update("1", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).not.toContain("agent");
    expect(lines[1]).toContain("Manual task");
  });

  it("does not show agent ID for pending tasks", () => {
    store.create("Pending agent task", "Desc", undefined, { agentType: "general-purpose", agentId: "abc12345" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).not.toContain("agent abc");
  });

  it("does not show agent ID for completed tasks", () => {
    store.create("Done", "Desc", undefined, { agentType: "general-purpose", agentId: "abc12345" });
    store.update("1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).not.toContain("agent abc");
  });
});

describe("Cascade data injection (buildTaskPrompt)", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(async () => {
    config.current = { autoCascade: true };

    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);

    // Set latestCtx via turn_start lifecycle event
    await mock.fireLifecycle("turn_start", {}, mockCtx());
  });

  afterEach(() => {
    rpc.unsub();
  });

  it("injects prerequisite result into cascaded agent prompt", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "Produce a result",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Use Task A result",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(rpc.spawned).toHaveLength(1);

    mock.emitEvent("subagents:completed", { id: "agent-1", result: "The answer is 42" });

    await vi.waitFor(() => expect(rpc.spawned).toHaveLength(2), { timeout: 1000 });

    const bPrompt = rpc.spawned[1].prompt;
    expect(bPrompt).toContain("Prerequisite task results");
    expect(bPrompt).toContain("Task #1");
    expect(bPrompt).toContain("The answer is 42");
  });

  it("truncates long prerequisite results at 4KB", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "Produce a long result",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Use truncated result",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    const longResult = "x".repeat(5000);
    mock.emitEvent("subagents:completed", { id: "agent-1", result: longResult });

    await vi.waitFor(() => expect(rpc.spawned).toHaveLength(2), { timeout: 1000 });

    const bPrompt = rpc.spawned[1].prompt;
    expect(bPrompt).toContain("truncated");
    expect(bPrompt).toContain("TaskGet");
    expect(bPrompt.length).toBeLessThan(longResult.length);
  });

  it("handles dependencies with no stored result gracefully", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Task A",
      description: "No result stored",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskCreate", {
      subject: "Task B",
      description: "Works without A result",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });

    mock.emitEvent("subagents:completed", { id: "agent-1" });

    await vi.waitFor(() => expect(rpc.spawned).toHaveLength(2), { timeout: 1000 });

    const bPrompt = rpc.spawned[1].prompt;
    expect(bPrompt).not.toContain("Prerequisite task results");
  });
});
