/**
 * task-paths.ts — Where task files live.
 *
 * Session-scoped state is runtime data, not project content, so it is keyed by
 * workspace under pi's agent directory rather than written into the repository.
 * That is where pi keeps its own per-workspace session logs, and where every
 * other extension keeps user-level state. Shared named lists
 * (`PI_TASKS=sprint-1`) sit alongside it.
 */

import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Root for task state that belongs to the user rather than to any one project.
 *  Resolved per call, never captured: `getAgentDir()` reads the environment. */
function tasksDir(): string {
  return join(getAgentDir(), "tasks");
}

/**
 * File backing a shared named list (`PI_TASKS=sprint-1`).
 *
 * These lived under a hardcoded `~/.pi/tasks/` before the agent directory was
 * followed. A list already sitting there keeps being read there — moving it
 * would orphan a list its owner can still name.
 */
export function sharedListFile(listId: string): string {
  const current = join(tasksDir(), `${listId}.json`);
  const legacy = join(homedir(), ".pi", "tasks", `${listId}.json`);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

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

/** Global directory holding every session's tasks for one workspace. */
export function sessionTasksDir(cwd: string): string {
  return join(tasksDir(), "sessions", projectKey(cwd));
}

/** Default task file for one persisted session in a workspace. */
export function sessionTaskFile(cwd: string, sessionId: string): string {
  return join(sessionTasksDir(cwd), `tasks-${sessionId}.json`);
}

/** Previous default location, retained only as a migration source. */
export function legacySessionTasksDir(cwd: string): string {
  return join(cwd, ".pi", "tasks");
}

/** Remove a workspace's session directory once it holds nothing. */
export function reclaimSessionTasksDir(cwd: string): void {
  try { rmdirSync(sessionTasksDir(cwd)); } catch { /* other sessions still stored */ }
}

/**
 * Move a workspace's leftover session files into global storage.
 *
 * The whole directory is swept, not just the session being opened: the point of
 * the move is that `.pi/tasks/` stops existing in the repository, and most of
 * the sessions that left a file behind will never be resumed to migrate their
 * own. Project scope's `tasks.json` is not a session file and stays put.
 *
 * Global state always wins — a file already there belongs to a session that has
 * run since the move, and its legacy counterpart is stale. Anything that cannot
 * be migrated is left untouched rather than risking its only copy.
 */
export function migrateLegacySessionTaskFiles(cwd: string): void {
  const legacyDir = legacySessionTasksDir(cwd);
  let entries: string[];
  try { entries = readdirSync(legacyDir); } catch { return; /* nothing to migrate */ }

  for (const entry of entries) {
    if (!entry.startsWith("tasks-") || !entry.endsWith(".json")) continue;
    const destination = join(sessionTasksDir(cwd), entry);
    try {
      mkdirSync(dirname(destination), { recursive: true });
      // COPYFILE_EXCL fails rather than overwriting, so the copy cannot clobber
      // global state — and the source is only dropped once it has landed.
      copyFileSync(join(legacyDir, entry), destination, constants.COPYFILE_EXCL);
      unlinkSync(join(legacyDir, entry));
    } catch { /* destination already exists, or the copy failed */ }
  }

  // Only ever removes an empty directory: a project-scope tasks.json, a stale
  // lock or an unmigrated file all keep it, and `.pi/` itself is not ours.
  try { rmdirSync(legacyDir); } catch { /* still holds other task state */ }
}
