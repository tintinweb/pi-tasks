/**
 * task-paths.ts — Where session task files live.
 *
 * `session` scope keeps them in the workspace, as it always has. `session-global`
 * keeps them under pi's agent directory instead, beside pi's own per-workspace
 * session logs, for people who would rather their repositories stayed clean.
 *
 * The choice only ever decides where a *new* file is created. A session already
 * holding a file in the workspace keeps using it under either setting, so opting
 * in moves nothing and opting back out strands nothing.
 */

import { existsSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TasksConfig } from "./tasks-config.js";

type TaskScope = NonNullable<TasksConfig["taskScope"]>;

/**
 * Directory name standing for one workspace.
 *
 * Mirrors the encoding pi uses for its own session logs
 * (`<agent-dir>/sessions/--Users-me-work-repo--/<timestamp>_<id>.jsonl`), so a
 * workspace's task files are named the same way as its transcripts and can be
 * found by eye.
 */
export function projectKey(cwd: string): string {
  return `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Where `session-global` collects one workspace's session files.
 *  Resolved per call, never captured: `getAgentDir()` reads the environment. */
export function globalSessionTasksDir(cwd: string): string {
  return join(getAgentDir(), "tasks", "sessions", projectKey(cwd));
}

/** The in-workspace location, unchanged since session scope was introduced. */
export function workspaceSessionTaskFile(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "tasks", `tasks-${sessionId}.json`);
}

/**
 * File backing one persisted session.
 *
 * Under `session-global` the workspace is still consulted first: a session that
 * already has a file there is still that file's session, and reading it is the
 * whole reason no migration is needed.
 */
export function sessionTaskFile(cwd: string, sessionId: string, scope: TaskScope): string {
  const inWorkspace = workspaceSessionTaskFile(cwd, sessionId);
  if (scope !== "session-global") return inWorkspace;
  return existsSync(inWorkspace) ? inWorkspace : join(globalSessionTasksDir(cwd), `tasks-${sessionId}.json`);
}

/**
 * Remove a workspace's global session directory once it holds nothing.
 *
 * Only the global tree is ever reclaimed. `<workspace>/.pi/tasks/` is left alone
 * even when it empties, because that is what every release so far has done and
 * `.pi/` holds project config that is not ours.
 */
export function reclaimGlobalSessionTasksDir(cwd: string): void {
  try { rmdirSync(globalSessionTasksDir(cwd)); } catch { /* other sessions still stored */ }
}
