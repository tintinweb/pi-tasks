/**
 * task-store.ts — File-backed task store with CRUD, dependency management, and file locking.
 *
 * Session-scoped (default): in-memory Map — no disk I/O.
 * Shared (PI_TASK_LIST_ID set): ~/.pi/tasks/<listId>.json with file locking.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Task, TaskStatus, TaskStoreData } from "./types.js";

const TASKS_DIR = join(homedir(), ".pi", "tasks");
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100; // 5s max

/** Ensure the directory for `filePath` exists. Idempotent and cheap. */
function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

/** Simple file-based locking. Recreates the parent dir if it was removed mid-stream. */
function acquireLock(lockPath: string): void {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      // Auto-heal: dir may have been deleted between operations.
      ensureDir(lockPath);
      // O_EXCL: fail if file exists
      writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        // Check for stale lock (process no longer running)
        try {
          const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
          if (pid && !isProcessRunning(pid)) {
            unlinkSync(lockPath);
            continue;
          }
        } catch { /* ignore read errors */ }
        // Wait and retry
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class TaskStore {
  private filePath: string | undefined;
  private lockPath: string | undefined;

  // In-memory state (always kept in sync)
  private nextId = 1;
  private tasks = new Map<string, Task>();

  /** Optional callback fired when load() detects a corrupt JSON file. */
  public onCorruptFile?: (filePath: string, error: unknown) => void;

  constructor(listIdOrPath?: string) {
    if (!listIdOrPath) return;
    const isAbsPath = isAbsolute(listIdOrPath);
    const filePath = isAbsPath ? listIdOrPath : join(TASKS_DIR, `${listIdOrPath}.json`);
    ensureDir(filePath);
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
  }

  /**
   * Read store from disk (file-backed mode only).
   *
   * Behavior:
   * - File missing (ENOENT): preserve in-memory state silently. The next save()
   *   recreates the file. This makes mid-stream file deletion survivable in-process.
   * - File present but unreadable / unparsable: preserve in-memory state and notify
   *   via `onCorruptFile`. Wiping state on parse failure has historically caused
   *   silent task loss; preserving is safer.
   */
  private load(): void {
    if (!this.filePath) return;
    if (!existsSync(this.filePath)) return;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch (err: any) {
      // ENOENT race: file vanished between existsSync and readFileSync. Preserve state.
      if (err?.code === "ENOENT") return;
      this.onCorruptFile?.(this.filePath, err);
      return;
    }
    try {
      const data: TaskStoreData = JSON.parse(raw);
      this.nextId = data.nextId;
      this.tasks.clear();
      for (const t of data.tasks) {
        this.tasks.set(t.id, t);
      }
    } catch (err) {
      // Corrupt JSON — preserve prior in-memory state instead of silently wiping.
      this.onCorruptFile?.(this.filePath, err);
    }
  }

  /** Write store to disk atomically (file-backed mode only). Auto-recreates the parent dir. */
  private save(): void {
    if (!this.filePath) return;
    const data: TaskStoreData = {
      nextId: this.nextId,
      tasks: Array.from(this.tasks.values()),
    };
    // Auto-heal: dir may have been deleted between operations.
    ensureDir(this.filePath);
    const tmpPath = this.filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  /** Execute a mutation with file locking (if file-backed). */
  private withLock<T>(fn: () => T): T {
    if (!this.lockPath) return fn();
    acquireLock(this.lockPath);
    try {
      this.load(); // Re-read latest state
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath);
    }
  }

  create(subject: string, description: string, activeForm?: string, metadata?: Record<string, any>): Task {
    return this.withLock(() => {
      const now = Date.now();
      const task: Task = {
        id: String(this.nextId++),
        subject,
        description,
        status: "pending",
        activeForm,
        owner: undefined,
        metadata: metadata ?? {},
        blocks: [],
        blockedBy: [],
        createdAt: now,
        updatedAt: now,
      };
      this.tasks.set(task.id, task);
      return task;
    });
  }

  get(id: string): Task | undefined {
    if (this.filePath) this.load();
    return this.tasks.get(id);
  }

  /** List all tasks sorted by ID ascending. */
  list(): Task[] {
    if (this.filePath) this.load();
    return Array.from(this.tasks.values()).sort((a, b) => Number(a.id) - Number(b.id));
  }

  /**
   * Update a task by ID.
   *
   * Returns:
   * - `task`: the updated task (undefined when the task was deleted or not found)
   * - `changedFields`: list of fields that were changed (`["deleted"]` for deletions, empty when not found)
   * - `warnings`: human-readable warnings (e.g., dependency cycles)
   * - `notFound`: true when no task with this id existed at update time. Callers in
   *   long-lived code paths (e.g., subagent completion listeners) MUST check this
   *   to avoid silently dropping work for tasks that were auto-cleared mid-flight.
   */
  update(id: string, fields: {
    status?: TaskStatus | "deleted";
    subject?: string;
    description?: string;
    activeForm?: string;
    owner?: string;
    metadata?: Record<string, any>;
    addBlocks?: string[];
    addBlockedBy?: string[];
  }): { task: Task | undefined; changedFields: string[]; warnings: string[]; notFound: boolean } {
    return this.withLock(() => {
      const task = this.tasks.get(id);
      if (!task) return { task: undefined, changedFields: [], warnings: [], notFound: true };

      const changedFields: string[] = [];
      const warnings: string[] = [];

      // Handle deletion
      if (fields.status === "deleted") {
        this.tasks.delete(id);
        // Clean up dependency edges pointing to this task
        for (const t of this.tasks.values()) {
          t.blocks = t.blocks.filter(bid => bid !== id);
          t.blockedBy = t.blockedBy.filter(bid => bid !== id);
        }
        return { task: undefined, changedFields: ["deleted"], warnings: [], notFound: false };
      }

      if (fields.status !== undefined) {
        task.status = fields.status;
        changedFields.push("status");
      }
      if (fields.subject !== undefined) {
        task.subject = fields.subject;
        changedFields.push("subject");
      }
      if (fields.description !== undefined) {
        task.description = fields.description;
        changedFields.push("description");
      }
      if (fields.activeForm !== undefined) {
        task.activeForm = fields.activeForm;
        changedFields.push("activeForm");
      }
      if (fields.owner !== undefined) {
        task.owner = fields.owner;
        changedFields.push("owner");
      }

      // Metadata: shallow merge, null deletes keys
      if (fields.metadata !== undefined) {
        for (const [key, value] of Object.entries(fields.metadata)) {
          if (value === null) {
            delete task.metadata[key];
          } else {
            task.metadata[key] = value;
          }
        }
        changedFields.push("metadata");
      }

      // Bidirectional dependency edges
      if (fields.addBlocks && fields.addBlocks.length > 0) {
        for (const targetId of fields.addBlocks) {
          if (!task.blocks.includes(targetId)) {
            task.blocks.push(targetId);
          }
          const target = this.tasks.get(targetId);
          if (target && !target.blockedBy.includes(id)) {
            target.blockedBy.push(id);
            target.updatedAt = Date.now();
          }
          // Warnings for problematic edges
          if (targetId === id) {
            warnings.push(`#${id} blocks itself`);
          } else if (!target) {
            warnings.push(`#${targetId} does not exist`);
          } else if (target.blocks.includes(id)) {
            warnings.push(`cycle: #${id} and #${targetId} block each other`);
          }
        }
        changedFields.push("blocks");
      }

      if (fields.addBlockedBy && fields.addBlockedBy.length > 0) {
        for (const targetId of fields.addBlockedBy) {
          if (!task.blockedBy.includes(targetId)) {
            task.blockedBy.push(targetId);
          }
          const target = this.tasks.get(targetId);
          if (target && !target.blocks.includes(id)) {
            target.blocks.push(id);
            target.updatedAt = Date.now();
          }
          // Warnings for problematic edges
          if (targetId === id) {
            warnings.push(`#${id} blocks itself`);
          } else if (!target) {
            warnings.push(`#${targetId} does not exist`);
          } else if (task.blocks.includes(targetId)) {
            warnings.push(`cycle: #${id} and #${targetId} block each other`);
          }
        }
        changedFields.push("blockedBy");
      }

      task.updatedAt = Date.now();
      return { task, changedFields, warnings, notFound: false };
    });
  }

  /** Delete a task by ID. Returns true if deleted. */
  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.tasks.has(id)) return false;
      this.tasks.delete(id);
      // Clean up dependency edges
      for (const t of this.tasks.values()) {
        t.blocks = t.blocks.filter(bid => bid !== id);
        t.blockedBy = t.blockedBy.filter(bid => bid !== id);
      }
      return true;
    });
  }

  /** Remove all tasks. */
  clearAll(): number {
    return this.withLock(() => {
      const count = this.tasks.size;
      this.tasks.clear();
      return count;
    });
  }

  /** Delete the backing file (if file-backed and empty). */
  deleteFileIfEmpty(): boolean {
    if (!this.filePath || this.tasks.size > 0) return false;
    try { unlinkSync(this.filePath); } catch { /* ignore */ }
    return true;
  }

  /** Remove all completed tasks. */
  clearCompleted(): number {
    return this.withLock(() => {
      let count = 0;
      for (const [id, task] of this.tasks) {
        if (task.status === "completed") {
          this.tasks.delete(id);
          count++;
        }
      }
      // Clean up dependency edges for deleted tasks
      if (count > 0) {
        const validIds = new Set(this.tasks.keys());
        for (const t of this.tasks.values()) {
          t.blocks = t.blocks.filter(bid => validIds.has(bid));
          t.blockedBy = t.blockedBy.filter(bid => validIds.has(bid));
        }
      }
      return count;
    });
  }
}
