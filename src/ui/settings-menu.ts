/**
 * settings-menu.ts — Polished settings panel for /tasks → Settings.
 *
 * Uses ui.custom() + SettingsList for native TUI rendering with keyboard
 * navigation, live toggle, and per-row descriptions — matching pi-coding-agent's
 * own settings panel style.
 */

import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@mariozechner/pi-tui";
import { saveTasksConfig, type TasksConfig } from "../tasks-config.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type SettingsUI = {
  custom<T>(
    factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
    options?: { overlay?: boolean; overlayOptions?: any },
  ): Promise<T>;
};

// ── Settings panel ──────────────────────────────────────────────────────────

export async function openSettingsMenu(
  ui: SettingsUI,
  cfg: TasksConfig,
  onBack: () => Promise<void>,
  clearDelayTurns: number,
): Promise<void> {
  await ui.custom((_tui, theme, _kb, done) => {
    const items: SettingItem[] = [
      {
        id: "persistenceBackend",
        label: "Task persistence backend",
        description:
          "file: save tasks outside the session in JSON files. " +
          "session_state: store task state in the Pi session history for proper branching. " +
          "Takes effect on next session start.",
        currentValue: cfg.persistenceBackend ?? "session_state",
        values: ["file", "session_state"],
      },
      {
        id: "taskScope",
        label: "Task storage",
        description:
          "memory: tasks live only in memory, lost when session ends. " +
          "session: persisted per session (tasks-<sessionId>.json), survives resume. " +
          "project: shared across all sessions (tasks.json). " +
          "Used only when Task persistence backend is file. Takes effect on next session start.",
        currentValue: cfg.taskScope ?? "session",
        values: ["memory", "session", "project"],
      },
      {
        id: "taskStorageLocation",
        label: "Task file location",
        description:
          "local: save file-backed tasks in the current project's .pi directory. " +
          "global: save file-backed tasks under ~/.pi/agent for this project. " +
          "Used only when Task persistence backend is file. Ignored by memory and session_state backends. Takes effect on next session start.",
        currentValue: cfg.taskStorageLocation ?? "local",
        values: ["local", "global"],
      },
      {
        id: "autoCascade",
        label: "Auto-execute with agents",
        description:
          "When ON: pending agent tasks start automatically once their dependencies complete. " +
          "When OFF: use TaskExecute to launch them manually.",
        currentValue: (cfg.autoCascade ?? false) ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "nudgeInterval",
        label: "Nudge interval",
        description:
          "How many non-task tool turns before injecting a reminder nudge. " +
          "0 disables nudges entirely.",
        currentValue: String(cfg.nudgeInterval ?? 4),
        values: ["0", "2", "4", "6", "8"],
      },
      {
        id: "autoClearCompleted",
        label: "Auto-clear completed tasks",
        description:
          "never: completed tasks stay visible until manually cleared. " +
          "on_list_complete: cleared automatically after all tasks are done. " +
          "on_task_complete: each task cleared shortly after it completes. " +
          `Clearing lags ~${clearDelayTurns} turns.`,
        currentValue: cfg.autoClearCompleted ?? "on_list_complete",
        values: ["never", "on_list_complete", "on_task_complete"],
      },
    ];

    const list = new SettingsList(
      items,
      /* maxVisible */ 10,
      getSettingsListTheme(),
      /* onChange */ (id, newValue) => {
        if (id === "autoCascade") {
          cfg.autoCascade = newValue === "on";
          saveTasksConfig(cfg);
        }
        if (id === "nudgeInterval") {
          cfg.nudgeInterval = parseInt(newValue, 10);
          saveTasksConfig(cfg);
        }
        if (id === "persistenceBackend") {
          cfg.persistenceBackend = newValue as NonNullable<TasksConfig["persistenceBackend"]>;
          saveTasksConfig(cfg);
        }
        if (id === "taskScope") {
          cfg.taskScope = newValue as "memory" | "session" | "project";
          saveTasksConfig(cfg);
        }
        if (id === "taskStorageLocation") {
          cfg.taskStorageLocation = newValue as NonNullable<TasksConfig["taskStorageLocation"]>;
          saveTasksConfig(cfg);
        }
        if (id === "autoClearCompleted") {
          cfg.autoClearCompleted = newValue as TasksConfig["autoClearCompleted"];
          saveTasksConfig(cfg);
        }
      },
      /* onCancel */ () => done(undefined),
    );

    // Container doesn't forward handleInput to children — subclass to fix.
    class SettingsPanel extends Container {
      handleInput(data: string) { list.handleInput(data); }
    }

    const root = new SettingsPanel();
    root.addChild(new Text(theme.bold(theme.fg("accent", "⚙  Task Settings")), 0, 0));
    root.addChild(new Spacer(1));
    root.addChild(list);

    return root;
  });

  return onBack();
}
