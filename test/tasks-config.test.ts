import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskSortOrder } from "../src/task-sort.js";
import { loadGlobalTasksConfig, loadTasksConfig, saveTasksConfig } from "../src/tasks-config.js";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe("tasks config", () => {
  let root: string;
  let cwd: string;
  let agentDir: string;
  let globalConfigPath: string;
  let projectConfigPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-tasks-config-"));
    cwd = join(root, "project");
    agentDir = join(root, "agent");
    globalConfigPath = join(agentDir, "tasks-config.json");
    projectConfigPath = join(cwd, ".pi", "tasks-config.json");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns an empty config when no files exist", () => {
    expect(loadTasksConfig(cwd, agentDir)).toEqual({});
  });

  it("loads global defaults from the agent directory", () => {
    writeJson(globalConfigPath, { autoCascade: true, maxVisible: 20 });

    expect(loadGlobalTasksConfig(agentDir)).toEqual({ autoCascade: true, maxVisible: 20 });
    expect(loadTasksConfig(cwd, agentDir)).toEqual({ autoCascade: true, maxVisible: 20 });
  });

  it("merges project overrides over global defaults", () => {
    writeJson(globalConfigPath, { autoCascade: true, maxVisible: 20, taskScope: "session" });
    writeJson(projectConfigPath, { autoCascade: false, maxVisible: 10 });

    expect(loadTasksConfig(cwd, agentDir)).toEqual({ autoCascade: false, maxVisible: 10, taskScope: "session" });
  });

  it("ignores a malformed global config", () => {
    writeFileSync(globalConfigPath, "{");
    writeJson(projectConfigPath, { autoCascade: false });

    expect(loadTasksConfig(cwd, agentDir)).toEqual({ autoCascade: false });
  });

  it("falls back to global defaults when the project config is malformed", () => {
    writeJson(globalConfigPath, { autoCascade: true });
    mkdirSync(dirname(projectConfigPath), { recursive: true });
    writeFileSync(projectConfigPath, "{");

    expect(loadTasksConfig(cwd, agentDir)).toEqual({ autoCascade: true });
  });

  it("ignores non-object config values", () => {
    writeJson(globalConfigPath, ["not", "a", "config"]);
    writeJson(projectConfigPath, null);

    expect(loadTasksConfig(cwd, agentDir)).toEqual({});
  });

  it("saves project settings when no global defaults exist", () => {
    saveTasksConfig({ autoCascade: true, maxVisible: 15 }, cwd, agentDir);

    expect(JSON.parse(readFileSync(projectConfigPath, "utf-8"))).toEqual({ autoCascade: true, maxVisible: 15 });
  });

  it("saves only values that differ from global defaults", () => {
    writeJson(globalConfigPath, { autoCascade: true, maxVisible: 20 });

    saveTasksConfig({ autoCascade: true, maxVisible: 30, showAll: false }, cwd, agentDir);

    expect(JSON.parse(readFileSync(projectConfigPath, "utf-8"))).toEqual({ maxVisible: 30, showAll: false });
    expect(JSON.parse(readFileSync(globalConfigPath, "utf-8"))).toEqual({ autoCascade: true, maxVisible: 20 });
  });

  it("preserves a project override across save and reload cycles", () => {
    writeJson(globalConfigPath, { autoCascade: true, maxVisible: 20 });
    const config = loadTasksConfig(cwd, agentDir);
    config.autoCascade = false;
    saveTasksConfig(config, cwd, agentDir);

    const reloaded = loadTasksConfig(cwd, agentDir);
    expect(reloaded).toEqual({ autoCascade: false, maxVisible: 20 });
    reloaded.maxVisible = 30;
    saveTasksConfig(reloaded, cwd, agentDir);

    expect(loadTasksConfig(cwd, agentDir)).toEqual({ autoCascade: false, maxVisible: 30 });
    expect(JSON.parse(readFileSync(projectConfigPath, "utf-8"))).toEqual({ autoCascade: false, maxVisible: 30 });
  });

  it("round-trips a custom sortOrder spec", () => {
    const sortOrder: TaskSortOrder = [
      { field: "status", rank: ["in_progress", "pending", "completed"] },
      { field: "id" },
    ];
    writeJson(projectConfigPath, { sortOrder });

    expect(loadTasksConfig(cwd, agentDir)).toEqual({ sortOrder });
  });

  it("does not copy a global sortOrder spec into the project override", () => {
    const sortOrder: TaskSortOrder = [{ field: "updatedAt", direction: "desc" }];
    writeJson(globalConfigPath, { sortOrder });

    saveTasksConfig(loadTasksConfig(cwd, agentDir), cwd, agentDir);

    expect(JSON.parse(readFileSync(projectConfigPath, "utf-8"))).toEqual({});
  });

  it("writes a sortOrder spec that differs from the global default", () => {
    writeJson(globalConfigPath, { sortOrder: "status" });
    const sortOrder: TaskSortOrder = [{ field: "id", direction: "desc" }];

    saveTasksConfig({ sortOrder }, cwd, agentDir);

    expect(JSON.parse(readFileSync(projectConfigPath, "utf-8"))).toEqual({ sortOrder });
  });

  it("writes an empty project override object when effective settings match global defaults", () => {
    writeJson(globalConfigPath, { autoCascade: true });

    saveTasksConfig({ autoCascade: true }, cwd, agentDir);

    expect(existsSync(projectConfigPath)).toBe(true);
    expect(JSON.parse(readFileSync(projectConfigPath, "utf-8"))).toEqual({});
  });

  it("merges icons per icon rather than replacing the whole set", () => {
    writeJson(globalConfigPath, { icons: { pending: "[ ]", spinner: ["|", "/"] } });
    writeJson(projectConfigPath, { icons: { completed: "[x]", spinner: ["-", "\\"] } });

    expect(loadTasksConfig(cwd, agentDir)).toEqual({
      icons: { pending: "[ ]", completed: "[x]", spinner: ["-", "\\"] },
    });
  });

  it("leaves icons absent when neither config sets any", () => {
    writeJson(globalConfigPath, { autoCascade: true });

    expect(loadTasksConfig(cwd, agentDir)).toEqual({ autoCascade: true });
  });

  it("does not copy global icons into the project override", () => {
    writeJson(globalConfigPath, { icons: { pending: "[ ]", completed: "[x]" } });
    const config = loadTasksConfig(cwd, agentDir);

    config.maxVisible = 5;
    saveTasksConfig(config, cwd, agentDir);

    expect(JSON.parse(readFileSync(projectConfigPath, "utf-8"))).toEqual({ maxVisible: 5 });
  });

  it("writes only the icons that differ from the global ones", () => {
    writeJson(globalConfigPath, { icons: { pending: "[ ]", completed: "[x]" } });

    saveTasksConfig({ icons: { pending: "[ ]", completed: "done", inProgress: "[>]" } }, cwd, agentDir);

    expect(JSON.parse(readFileSync(projectConfigPath, "utf-8"))).toEqual({
      icons: { completed: "done", inProgress: "[>]" },
    });
  });

  it("preserves a project icon override across save and reload cycles", () => {
    writeJson(globalConfigPath, { icons: { pending: "[ ]" } });
    writeJson(projectConfigPath, { icons: { completed: "[x]" } });

    saveTasksConfig(loadTasksConfig(cwd, agentDir), cwd, agentDir);

    expect(JSON.parse(readFileSync(projectConfigPath, "utf-8"))).toEqual({ icons: { completed: "[x]" } });
    expect(loadTasksConfig(cwd, agentDir)).toEqual({ icons: { pending: "[ ]", completed: "[x]" } });
  });
});
