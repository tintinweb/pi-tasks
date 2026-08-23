/**
 * Where tasks are stored: the taskScope config, the PI_TASKS override, and what
 * session_start does with an already-persisted list.
 *
 * Every context carries a temp workspace: task paths resolve against ctx.cwd, and
 * .pi/ in the real working directory holds the developer's own task list.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { sessionTaskFile as globalSessionTaskFile, legacySessionTasksDir } from "../src/task-paths.js";
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
const sessionFile = (id: string) => globalSessionTaskFile(cwd, id);

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

  it("writes persisted session state globally without creating project metadata", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1"));
    await mock.executeTool("TaskCreate", { subject: "Durable", description: "d" });

    expect(existsSync(sessionFile("s1"))).toBe(true);
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
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

  it("migrates every leftover session file, not just the one being opened", async () => {
    // The sessions that left the other files behind may never be resumed, and
    // .pi/tasks/ only stops existing in the repository once they are all gone.
    const legacyDir = legacySessionTasksDir(cwd);
    new TaskStore(join(legacyDir, "tasks-s1.json")).create("Opened session", "d");
    new TaskStore(join(legacyDir, "tasks-s9.json")).create("Abandoned session", "d");
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("session_start", { reason: "resume" }, ctxFor("s1"));

    expect(new TaskStore(sessionFile("s9")).list().map(t => t.subject)).toEqual(["Abandoned session"]);
    expect(existsSync(legacyDir)).toBe(false);
  });

  it("leaves a project-scope task list where it belongs", async () => {
    // tasks.json is shared project state, not session state — migrating it would
    // silently move a list the project scope still expects to find in the repo.
    const legacyDir = legacySessionTasksDir(cwd);
    new TaskStore(join(legacyDir, "tasks.json")).create("Shared list", "d");
    new TaskStore(join(legacyDir, "tasks-s1.json")).create("Session task", "d");
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("session_start", { reason: "resume" }, ctxFor("s1"));

    expect(existsSync(join(legacyDir, "tasks.json"))).toBe(true);
    expect(existsSync(join(legacyDir, "tasks-s1.json"))).toBe(false);
  });

  it("lazily migrates the matching legacy workspace file", async () => {
    const legacyFile = join(legacySessionTasksDir(cwd), "tasks-s1.json");
    new TaskStore(legacyFile).create("Legacy task", "d");
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("session_start", { reason: "resume" }, ctxFor("s1"));

    expect(new TaskStore(sessionFile("s1")).list().map(t => t.subject)).toEqual(["Legacy task"]);
    expect(existsSync(legacyFile)).toBe(false);
    expect(existsSync(legacySessionTasksDir(cwd))).toBe(false);
  });

  it("keeps a legacy file when global state already exists", async () => {
    const legacyFile = join(legacySessionTasksDir(cwd), "tasks-s1.json");
    new TaskStore(legacyFile).create("Legacy task", "d");
    new TaskStore(sessionFile("s1")).create("Global task", "d");
    const mock = mockPi();
    initExtension(mock.pi as any);

    await mock.fireLifecycle("session_start", { reason: "resume" }, ctxFor("s1"));

    expect(new TaskStore(sessionFile("s1")).list().map(t => t.subject)).toEqual(["Global task"]);
    expect(existsSync(legacyFile)).toBe(true);
  });
});
