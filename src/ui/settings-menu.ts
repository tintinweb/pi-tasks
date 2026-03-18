/**
 * settings-menu.ts — Polished settings panel for /tasks → Settings.
 *
 * Uses ui.custom() + SettingsList for native TUI rendering with keyboard
 * navigation, live toggle, and per-row descriptions — matching pi-coding-agent's
 * own settings panel style.
 */

import { SettingsList, Container, Text, Spacer, type SettingItem } from "@mariozechner/pi-tui";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
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
        label: "Auto-clear completed",
        description:
          "When ON: completed/skipped tasks are automatically cleared when creating new tasks. " +
          "When OFF: use clearCompleted param or /tasks menu to clear manually.",
        currentValue: (cfg.autoClearCompleted ?? false) ? "on" : "off",
        values: ["on", "off"],
      },
    ];

    const list = new SettingsList(
      items,
      /* maxVisible */ 10,
      getSettingsListTheme(),
      /* onChange */ (id, newValue) => {
        if (id === "autoCascade") {
          cfg.autoCascade = newValue === "on";
        } else if (id === "taskScope") {
          cfg.taskScope = newValue as "memory" | "session" | "project";
        } else if (id === "nudgeInterval") {
          cfg.nudgeInterval = parseInt(newValue, 10);
        } else if (id === "autoClearCompleted") {
          cfg.autoClearCompleted = newValue === "on";
        }
        saveTasksConfig(cfg);
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
