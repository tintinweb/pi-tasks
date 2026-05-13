/**
 * settings-menu.ts — Polished settings panel for /tasks → Settings.
 *
 * Uses ui.custom() + SettingsList for native TUI rendering with keyboard
 * navigation, live toggle, and per-row descriptions — matching pi-coding-agent's
 * own settings panel style.
 */

import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
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
        id: "taskScope",
        label: "Task storage",
        description:
          "memory: tasks live only in memory, lost when session ends. " +
          "session: persisted per session (tasks-<sessionId>.json), survives resume. " +
          "project: shared across all sessions (tasks.json). " +
          "Takes effect on next session start.",
        currentValue: cfg.taskScope ?? "session",
        values: ["memory", "session", "project"],
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
        id: "showAll",
        label: "Show all tasks in widget",
        description:
          "When ON, every task is shown regardless of the visible limit. " +
          "When OFF, the list is capped by 'Max visible tasks'.",
        currentValue: (cfg.showAll ?? false) ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "maxVisible",
        label: "Max visible tasks in widget",
        description:
          "Only applies when 'Show all tasks' is OFF. " +
          "Caps how many task lines the widget shows.",
        currentValue: String(cfg.maxVisible ?? 10),
        values: ["5", "10", "15", "20", "30", "50", "100"],
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
        if (id === "taskScope") {
          cfg.taskScope = newValue as "memory" | "session" | "project";
          saveTasksConfig(cfg);
        }
        if (id === "autoClearCompleted") {
          cfg.autoClearCompleted = newValue as TasksConfig["autoClearCompleted"];
          saveTasksConfig(cfg);
        }
        if (id === "showAll") {
          cfg.showAll = newValue === "on";
          saveTasksConfig(cfg);
        }
        if (id === "maxVisible") {
          cfg.maxVisible = Number(newValue);
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
