import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectStorageKey, getTaskStorageDir, resolveTaskStorePath } from "../src/storage-paths.js";

describe("storage-paths", () => {
  const cwd = "/Users/shubs/Projects/OSS/pi-tasks";
  const agentDir = "/Users/shubs/.pi/agent";
  const projectKey = getProjectStorageKey(cwd);

  it("builds a stable project storage key", () => {
    expect(projectKey).toBe("--Users-shubs-Projects-OSS-pi-tasks--");
  });

  it("uses local project .pi directory for local storage", () => {
    expect(getTaskStorageDir(cwd, "local", agentDir)).toBe(join(cwd, ".pi", "tasks"));
  });

  it("uses global pi extension directory for global storage", () => {
    expect(getTaskStorageDir(cwd, "global", agentDir)).toBe(
      join(agentDir, "extensions", "pi-tasks", projectKey, "tasks"),
    );
  });

  it("returns session-scoped local path when session ID is available", () => {
    expect(resolveTaskStorePath({ cwd, taskScope: "session", storageLocation: "local", sessionId: "abc", agentDir })).toBe(
      join(cwd, ".pi", "tasks", "tasks-abc.json"),
    );
  });

  it("returns session-scoped global path when session ID is available", () => {
    expect(resolveTaskStorePath({ cwd, taskScope: "session", storageLocation: "global", sessionId: "abc", agentDir })).toBe(
      join(agentDir, "extensions", "pi-tasks", projectKey, "tasks", "tasks-abc.json"),
    );
  });

  it("returns project-scoped local path", () => {
    expect(resolveTaskStorePath({ cwd, taskScope: "project", storageLocation: "local", agentDir })).toBe(
      join(cwd, ".pi", "tasks", "tasks.json"),
    );
  });

  it("returns project-scoped global path", () => {
    expect(resolveTaskStorePath({ cwd, taskScope: "project", storageLocation: "global", agentDir })).toBe(
      join(agentDir, "extensions", "pi-tasks", projectKey, "tasks", "tasks.json"),
    );
  });

  it("returns undefined for session scope before session ID exists", () => {
    expect(resolveTaskStorePath({ cwd, taskScope: "session", storageLocation: "global", agentDir })).toBeUndefined();
  });

  it("returns undefined for memory mode regardless of location", () => {
    expect(resolveTaskStorePath({ cwd, taskScope: "memory", storageLocation: "local", agentDir })).toBeUndefined();
    expect(resolveTaskStorePath({ cwd, taskScope: "memory", storageLocation: "global", agentDir })).toBeUndefined();
  });

  it("lets PI_TASKS=off force in-memory mode", () => {
    expect(resolveTaskStorePath({ cwd, taskScope: "project", storageLocation: "global", piTasks: "off", agentDir })).toBeUndefined();
  });

  it("preserves explicit absolute PI_TASKS path", () => {
    expect(resolveTaskStorePath({ cwd, taskScope: "project", storageLocation: "global", piTasks: "/tmp/tasks.json", agentDir })).toBe(
      "/tmp/tasks.json",
    );
  });

  it("resolves relative PI_TASKS path from cwd", () => {
    expect(resolveTaskStorePath({ cwd, taskScope: "project", storageLocation: "global", piTasks: "./tasks.json", agentDir })).toBe(
      resolve(cwd, "./tasks.json"),
    );
  });

  it("preserves named PI_TASKS list IDs", () => {
    expect(resolveTaskStorePath({ cwd, taskScope: "project", storageLocation: "global", piTasks: "shared-list", agentDir })).toBe(
      "shared-list",
    );
  });
});
