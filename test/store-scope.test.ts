/**
 * Where tasks are stored: the taskScope config, the PI_TASKS override, and what
 * session_start does with an already-persisted list.
 *
 * Every context carries a temp workspace: task paths resolve against ctx.cwd, and
 * .pi/ in the real working directory holds the developer's own task list.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { TaskStore } from "../src/task-store.js";
import { mockPi, mockSessionCtx } from "./helpers/mock-pi.js";

const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/tasks-config.js", () => ({
  loadGlobalTasksConfig: () => ({ ...config.current }),
  loadTasksConfig: () => ({ ...config.current }),
  saveTasksConfig: () => {},
}));

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-tasks-scope-"));
  config.current = {};
  delete process.env.PI_TASKS;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PI_TASKS;
  rmSync(cwd, { recursive: true, force: true });
});

/** Every context carries the workspace, since that is what task paths resolve against. */
const ctxFor = (sessionId = "s1", opts?: { persisted?: boolean }) =>
  mockSessionCtx(sessionId, { ...opts, cwd });
const projectFile = () => join(cwd, ".pi", "tasks", "tasks.json");
const sessionFile = (id: string) => join(cwd, ".pi", "tasks", `tasks-${id}.json`);

describe("taskScope: project", () => {
  beforeEach(() => { config.current = { taskScope: "project" }; });

  it("persists to a single shared file", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1"));
    await mock.executeTool("TaskCreate", { subject: "Shared", description: "d" });

    expect(existsSync(projectFile())).toBe(true);
    expect(new TaskStore(projectFile()).list().map(t => t.subject)).toEqual(["Shared"]);
  });

  it("stays on the same file when the session changes", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1"));
    await mock.executeTool("TaskCreate", { subject: "Before", description: "d" });

    await mock.fireLifecycle("session_start", { reason: "new" }, ctxFor("s2"));
    await mock.executeTool("TaskCreate", { subject: "After", description: "d" });

    expect(existsSync(sessionFile("s1"))).toBe(false);
    expect(existsSync(sessionFile("s2"))).toBe(false);
    expect(new TaskStore(projectFile()).list().map(t => t.subject)).toEqual(["Before", "After"]);
  });
});

describe("taskScope: memory", () => {
  beforeEach(() => { config.current = { taskScope: "memory" }; });

  it("never touches the filesystem", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1"));
    await mock.executeTool("TaskCreate", { subject: "Ephemeral", description: "d" });

    expect(existsSync(join(cwd, ".pi"))).toBe(false);
    expect((await mock.executeTool("TaskList", {})).content[0].text).toContain("Ephemeral");
  });

  it("clears tasks on /new, since there is no file to switch away from", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1"));
    await mock.executeTool("TaskCreate", { subject: "Ephemeral", description: "d" });

    await mock.fireLifecycle("session_start", { reason: "new" }, ctxFor("s2"));

    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
  });

  it("keeps tasks across a reload", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1"));
    await mock.executeTool("TaskCreate", { subject: "Ephemeral", description: "d" });

    await mock.fireLifecycle("session_start", { reason: "reload" }, ctxFor("s1"));

    expect((await mock.executeTool("TaskList", {})).content[0].text).toContain("Ephemeral");
  });
});

describe("taskScope: session, without a persisted session", () => {
  // pi --no-session (and SessionManager.inMemory()) mints a session ID but never a
  // session file. A session task file written for it is orphaned the moment pi exits.
  it("keeps tasks in memory and leaves nothing on disk", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1", { persisted: false }));
    await mock.executeTool("TaskCreate", { subject: "Ephemeral", description: "d" });

    expect(existsSync(join(cwd, ".pi"))).toBe(false);
    expect((await mock.executeTool("TaskList", {})).content[0].text).toContain("Ephemeral");
  });

  it("still writes a session file when the session is persisted", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1"));
    await mock.executeTool("TaskCreate", { subject: "Durable", description: "d" });

    expect(existsSync(sessionFile("s1"))).toBe(true);
  });

  it("does not fall back to a file when a later lifecycle event fires", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    const ctx = ctxFor("s1", { persisted: false });
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    await mock.fireLifecycle("turn_start", {}, ctx);
    await mock.executeTool("TaskCreate", { subject: "Ephemeral", description: "d" });

    expect(existsSync(join(cwd, ".pi"))).toBe(false);
  });
});

describe("PI_TASKS override", () => {
  it("resolves a relative path against the session workspace", async () => {
    process.env.PI_TASKS = "./custom/list.json";
    config.current = { taskScope: "memory" }; // overridden by the env var

    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1"));
    await mock.executeTool("TaskCreate", { subject: "Relative", description: "d" });

    const file = join(cwd, "custom", "list.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf-8")).tasks[0].subject).toBe("Relative");
  });

  it("keeps everything in memory when set to off, even in project scope", async () => {
    process.env.PI_TASKS = "off";
    config.current = { taskScope: "project" };

    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.executeTool("TaskCreate", { subject: "Nowhere", description: "d" });

    expect(existsSync(join(cwd, ".pi"))).toBe(false);
  });
});

describe("session_start with a persisted list", () => {
  /** Write a session file holding tasks in the given states. */
  function seed(sessionId: string, statuses: Array<"pending" | "completed">) {
    mkdirSync(join(cwd, ".pi", "tasks"), { recursive: true });
    const store = new TaskStore(sessionFile(sessionId));
    statuses.forEach((status, i) => {
      const task = store.create(`Task ${i + 1}`, "d");
      if (status !== "pending") store.update(task.id, { status });
    });
  }

  it("wipes an all-completed list on startup, leaving no session file behind", async () => {
    seed("s1", ["completed", "completed"]);
    const mock = mockPi();
    initExtension(mock.pi as any);

    const ctx = ctxFor("s1");
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

    expect(existsSync(sessionFile("s1"))).toBe(false);
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  it("keeps an all-completed list on resume and shows the widget", async () => {
    seed("s1", ["completed", "completed"]);
    const mock = mockPi();
    initExtension(mock.pi as any);

    const ctx = ctxFor("s1");
    await mock.fireLifecycle("session_start", { reason: "resume" }, ctx);

    expect(existsSync(sessionFile("s1"))).toBe(true);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("tasks", expect.any(Function), {
      placement: "aboveEditor",
    });
  });

  it("keeps a partially finished list on startup", async () => {
    seed("s1", ["completed", "pending"]);
    const mock = mockPi();
    initExtension(mock.pi as any);

    const ctx = ctxFor("s1");
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

    expect(existsSync(sessionFile("s1"))).toBe(true);
    expect(ctx.ui.setWidget).toHaveBeenCalled();
  });
});
