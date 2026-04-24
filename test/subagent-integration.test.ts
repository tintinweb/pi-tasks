/**
 * Tests for task-subagent integration: TaskExecute tool, completion listener,
 * auto-cascade, and widget agent ID display.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { buildTaskSessionStateDetails, SessionStateTaskStore, TASKS_SESSION_STATE_TYPE } from "../src/session-state-store.js";
import { TaskStore } from "../src/task-store.js";
import { TaskWidget, type Theme, type UICtx } from "../src/ui/task-widget.js";

// Force in-memory task store for all integration tests — prevents file-backed
// store from loading stale tasks across test instances.
beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

// ---- Mock pi ----

type MockEventBus = {
  on: (channel: string, handler: (data: unknown) => void) => () => void;
  emit: (channel: string, data: unknown) => void;
};

/** Minimal mock of ExtensionAPI with events, tool capture, and event hooks. */
function mockPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();

  const pi = {
    registerTool(def: any) { tools.set(def.name, def); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const h of eventHandlers.get(channel) ?? []) h(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
        eventHandlers.get(channel)!.push(handler);
        return () => {
          const arr = eventHandlers.get(channel);
          if (arr) eventHandlers.set(channel, arr.filter(h => h !== handler));
        };
      },
    },
    sendUserMessage: vi.fn(),
  };

  return {
    pi,
    tools,
    commands,
    /** Execute a registered tool by name. */
    async executeTool(name: string, params: any, ctx?: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, undefined, undefined, ctx ?? mockCtx());
    },
    /** Fire lifecycle event handlers (turn_start, tool_result, etc.) */
    async fireLifecycle(event: string, ...args: any[]) {
      for (const h of lifecycleHandlers.get(event) ?? []) {
        await h(...args);
      }
    },
    /** Emit an event on pi.events (simulates subagent extension). */
    emitEvent(channel: string, data: unknown) {
      pi.events.emit(channel, data);
    },
  };
}

/** Minimal mock ExtensionContext. */
function mockCtx(overrides: Record<string, any> = {}) {
  return {
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    ui: overrides.ui ?? {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
    sessionManager: overrides.sessionManager ?? {
      getBranch: () => [],
      getSessionId: () => "test-session",
      getSessionFile: () => "/tmp/test-session.jsonl",
    },
    ...overrides,
  };
}

// ---- Mock subagents extension (RPC responders) ----

/** Simulates the @tintinweb/pi-subagents extension: responds to ping + spawn RPCs and emits ready. */
function installSubagentsMock(pi: { events: MockEventBus }, opts?: { spawnError?: string }) {
  let idCounter = 0;
  const spawned: Array<{ id: string; type: string; prompt: string; options: any }> = [];
  const stopped: string[] = [];

  // Respond to ping — reply on scoped channel
  const unsubPing = pi.events.on("subagents:rpc:ping", (data: unknown) => {
    const { requestId } = data as { requestId: string };
    pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: 2 } });
  });

  // Respond to spawn — reply on scoped channel
  const unsubSpawn = pi.events.on("subagents:rpc:spawn", (data: unknown) => {
    const { requestId, type, prompt, options } = data as {
      requestId: string; type: string; prompt: string; options?: any;
    };
    if (opts?.spawnError) {
      pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: false, error: opts.spawnError });
      return;
    }
    const id = `agent-${++idCounter}`;
    spawned.push({ id, type, prompt, options });
    pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: true, data: { id } });
  });

  // Respond to stop — reply on scoped channel
  const unsubStop = pi.events.on("subagents:rpc:stop", (data: unknown) => {
    const { requestId, agentId } = data as { requestId: string; agentId: string };
    const known = spawned.some(s => s.id === agentId);
    if (known) {
      stopped.push(agentId);
      pi.events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: true });
    } else {
      pi.events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: false, error: "Agent not found" });
    }
  });

  // Broadcast readiness
  pi.events.emit("subagents:ready", {});

  return {
    spawned,
    stopped,
    unsub() { unsubPing(); unsubSpawn(); unsubStop(); },
  };
}

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
    const update = await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });
    expect(update.content[0].text).toContain("Updated task #1 status: pending → in_progress");
    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("in_progress");
  });

  it("TaskUpdate supports batch mode without subagents", async () => {
    await mock.executeTool("TaskCreate", { subject: "First", description: "desc" });
    await mock.executeTool("TaskCreate", { subject: "Second", description: "desc" });

    const result = await mock.executeTool("TaskUpdate", {
      tasks: [
        { taskId: "1", status: "in_progress" },
        { taskId: "2", owner: "agent-2", addBlockedBy: ["1"] },
      ],
    });

    expect(result.content[0].text).toContain("Processed 2 task(s)");
    expect(result.content[0].text).toContain("Updated task #1 status: pending → in_progress");
    expect(result.content[0].text).toContain("Updated task #2 owner: none → agent-2; blockedBy: [] → [#1]");

    const first = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(first.content[0].text).toContain("in_progress");

    const second = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(second.content[0].text).toContain("Owner: agent-2");
    expect(second.content[0].text).toContain("Blocked by: #1");
  });

  it("TaskUpdate batch mode reports missing tasks", async () => {
    await mock.executeTool("TaskCreate", { subject: "Only task", description: "desc" });

    const result = await mock.executeTool("TaskUpdate", {
      tasks: [
        { taskId: "1", status: "completed" },
        { taskId: "999", status: "completed" },
      ],
    });

    expect(result.content[0].text).toContain("Updated task #1 status: pending → completed");
    expect(result.content[0].text).toContain("Task #999 not found");
  });

  it("TaskExecute gracefully refuses without subagents", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Agent task",
      description: "desc",
      agentType: "general-purpose",
    });
    const result = await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    expect(result.content[0].text).toContain("Subagent execution is currently unavailable");
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
  it("tasks:rpc:updateMany supports single-task updates", async () => {
    const mock = mockPi();
    const replies: unknown[] = [];
    mock.pi.events.on("tasks:rpc:updateMany:reply:req-1", data => { replies.push(data); });
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "RPC single", description: "desc" });
    mock.emitEvent("tasks:rpc:updateMany", {
      requestId: "req-1",
      taskId: "1",
      fields: { status: "completed" },
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual({ success: true });

    const result = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(result.content[0].text).toContain("completed");
  });

  it("tasks:rpc:updateMany supports batch updates", async () => {
    const mock = mockPi();
    const replies: unknown[] = [];
    mock.pi.events.on("tasks:rpc:updateMany:reply:req-2", data => { replies.push(data); });
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "RPC first", description: "desc" });
    await mock.executeTool("TaskCreate", { subject: "RPC second", description: "desc" });
    mock.emitEvent("tasks:rpc:updateMany", {
      requestId: "req-2",
      tasks: [
        { taskId: "1", status: "in_progress" },
        { taskId: "2", fields: { owner: "agent-2", addBlockedBy: ["1"] } },
      ],
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual({ success: true, ids: ["1", "2"] });

    const first = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(first.content[0].text).toContain("in_progress");

    const second = await mock.executeTool("TaskGet", { taskId: "2" });
    expect(second.content[0].text).toContain("Owner: agent-2");
    expect(second.content[0].text).toContain("Blocked by: #1");
  });

  it("tasks:rpc:updateMany batch reports missing IDs and warnings", async () => {
    const mock = mockPi();
    const replies: unknown[] = [];
    mock.pi.events.on("tasks:rpc:updateMany:reply:req-3", data => { replies.push(data); });
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", { subject: "RPC existing", description: "desc" });
    mock.emitEvent("tasks:rpc:updateMany", {
      requestId: "req-3",
      tasks: [
        { taskId: "1", addBlockedBy: ["999"] },
        { taskId: "999", status: "completed" },
      ],
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual({
      success: false,
      ids: ["1"],
      missingIds: ["999"],
      warnings: ["#999 does not exist"],
    });
  });

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

describe("Session-state resume", () => {
  it("preserves completed persisted tasks on session_start resume", async () => {
    delete process.env.PI_TASKS;

    const mock = mockPi();
    initExtension(mock.pi as any);

    const persisted = new SessionStateTaskStore();
    for (let i = 0; i < 14; i++) {
      persisted.create(`Task ${i + 1}`, "Desc");
      persisted.update(String(i + 1), { status: "completed" });
    }

    const ctx = mockCtx({
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: TASKS_SESSION_STATE_TYPE,
            data: buildTaskSessionStateDetails(persisted),
          },
        ],
        getSessionId: () => "resume-session",
        getSessionFile: () => "/tmp/resume-session.jsonl",
      },
    });

    await mock.fireLifecycle("session_start", { reason: "resume", previousSessionFile: "/tmp/previous-session.jsonl" }, ctx);
    await mock.fireLifecycle("before_agent_start", {}, ctx);

    const listResult = await mock.executeTool("TaskList", {}, ctx);
    expect(listResult.content[0].text).toContain("#1 [completed] Task 1");
    expect(listResult.content[0].text).toContain("#14 [completed] Task 14");

    const createResult = await mock.executeTool("TaskCreate", {
      subject: "Task 15",
      description: "Created after resume",
    }, ctx);
    expect(createResult.content[0].text).toContain("Task #15: Task 15");
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
