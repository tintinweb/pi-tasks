import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTasksConfig, saveTasksConfig } from "../src/tasks-config.js";

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

  it("writes an empty project override object when effective settings match global defaults", () => {
    writeJson(globalConfigPath, { autoCascade: true });

    saveTasksConfig({ autoCascade: true }, cwd, agentDir);

    expect(existsSync(projectConfigPath)).toBe(true);
    expect(JSON.parse(readFileSync(projectConfigPath, "utf-8"))).toEqual({});
  });
});
