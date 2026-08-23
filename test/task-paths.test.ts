/**
 * Where session task files land. The location is a compatibility surface: it is
 * the path users look in, and the one an older release wrote to.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { projectKey, sessionTaskFile, sessionTasksDir } from "../src/task-paths.js";

describe("projectKey", () => {
  it("names a workspace the way pi names it in its own session logs", () => {
    // pi writes transcripts to <agent-dir>/sessions/--Users-me-work-repo--/, so
    // a workspace's tasks and its transcripts are found under the same name.
    expect(projectKey("/Users/me/work/repo")).toBe("--Users-me-work-repo--");
  });

  it("keeps different workspaces apart", () => {
    expect(projectKey("/Users/me/a")).not.toBe(projectKey("/Users/me/b"));
  });

  it("resolves a relative workspace against the process directory", () => {
    expect(projectKey(".")).toBe(projectKey(process.cwd()));
  });
});

describe("sessionTaskFile", () => {
  it("stores tasks outside the workspace, under pi's agent directory", () => {
    const file = sessionTaskFile("/Users/me/work/repo", "abc");
    expect(file).toBe(join(getAgentDir(), "tasks", "sessions", "--Users-me-work-repo--", "tasks-abc.json"));
    expect(file.startsWith("/Users/me/work/repo")).toBe(false);
  });

  it("follows a relocated agent directory", () => {
    // pi honours PI_CODING_AGENT_DIR for its own state; task files are state too,
    // and pinning them to the home directory would strand them behind it.
    const relocated = mkdtempSync(join(tmpdir(), "pi-tasks-agent-dir-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", relocated);
    try {
      expect(sessionTaskFile("/Users/me/work/repo", "abc")).toBe(
        join(relocated, "tasks", "sessions", "--Users-me-work-repo--", "tasks-abc.json"),
      );
    } finally {
      vi.unstubAllEnvs();
      rmSync(relocated, { recursive: true, force: true });
    }
  });

  it("keeps sessions in one workspace together", () => {
    const cwd = "/Users/me/work/repo";
    expect(sessionTaskFile(cwd, "a").startsWith(sessionTasksDir(cwd))).toBe(true);
    expect(sessionTaskFile(cwd, "b").startsWith(sessionTasksDir(cwd))).toBe(true);
  });
});
