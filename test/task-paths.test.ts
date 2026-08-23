/**
 * Where session task files land. The location is a compatibility surface: it is
 * the path users look in, and the one every release so far has written to.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { globalSessionTasksDir, projectKey, sessionTaskFile } from "../src/task-paths.js";

const scratch: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-tasks-paths-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

describe("sessionTaskFile under the default `session` scope", () => {
  it("writes into the workspace, exactly where every release so far has", () => {
    // This is the compatibility guarantee: upgrading must not move anyone's
    // tasks. The path is asserted literally rather than via a helper.
    expect(sessionTaskFile("/Users/me/work/repo", "abc", "session"))
      .toBe(join("/Users/me/work/repo", ".pi", "tasks", "tasks-abc.json"));
  });

  it("ignores the agent directory entirely", () => {
    const cwd = workspace();
    expect(sessionTaskFile(cwd, "abc", "session").startsWith(getAgentDir())).toBe(false);
  });
});

describe("sessionTaskFile under `session-global`", () => {
  it("keeps a new session's tasks outside the workspace", () => {
    const cwd = workspace();
    const file = sessionTaskFile(cwd, "abc", "session-global");

    expect(file).toBe(join(getAgentDir(), "tasks", "sessions", projectKey(cwd), "tasks-abc.json"));
    expect(file.startsWith(cwd)).toBe(false);
  });

  it("leaves a session that already has a workspace file where it is", () => {
    // Opting in changes where new files are created; it does not move data. A
    // session resolved anywhere else would look empty to the user who resumes it.
    const cwd = workspace();
    const existing = join(cwd, ".pi", "tasks", "tasks-abc.json");
    mkdirSync(dirname(existing), { recursive: true });
    writeFileSync(existing, JSON.stringify({ nextId: 1, tasks: [] }));

    expect(sessionTaskFile(cwd, "abc", "session-global")).toBe(existing);
  });

  it("does not confuse one session's workspace file for another's", () => {
    const cwd = workspace();
    const existing = join(cwd, ".pi", "tasks", "tasks-abc.json");
    mkdirSync(dirname(existing), { recursive: true });
    writeFileSync(existing, JSON.stringify({ nextId: 1, tasks: [] }));

    expect(sessionTaskFile(cwd, "xyz", "session-global")).toBe(join(globalSessionTasksDir(cwd), "tasks-xyz.json"));
  });

  it("follows a relocated agent directory", () => {
    // pi honours PI_CODING_AGENT_DIR for its own state; task files are state too,
    // and pinning them to the home directory would strand them behind it.
    const relocated = workspace();
    const cwd = workspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", relocated);

    expect(sessionTaskFile(cwd, "abc", "session-global"))
      .toBe(join(relocated, "tasks", "sessions", projectKey(cwd), "tasks-abc.json"));
  });

  it("keeps sessions in one workspace together", () => {
    const cwd = workspace();
    expect(sessionTaskFile(cwd, "a", "session-global").startsWith(globalSessionTasksDir(cwd))).toBe(true);
    expect(sessionTaskFile(cwd, "b", "session-global").startsWith(globalSessionTasksDir(cwd))).toBe(true);
  });
});
