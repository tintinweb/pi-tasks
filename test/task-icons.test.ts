import { describe, expect, it } from "vitest";
import { resolveTaskIcons, type TaskIconsConfig } from "../src/task-icons.js";

describe("resolveTaskIcons", () => {
  it("returns the built-in icons when nothing is configured", () => {
    const icons = resolveTaskIcons(undefined);

    expect(icons.completed).toBe("✔");
    expect(icons.inProgress).toBe("◼");
    expect(icons.pending).toBe("◻");
    expect(icons.spinner).toEqual(["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"]);
  });

  it("returns the built-in icons for an empty icon object", () => {
    expect(resolveTaskIcons({})).toEqual(resolveTaskIcons(undefined));
  });

  it("applies configured icons", () => {
    const icons = resolveTaskIcons({
      completed: "[x]",
      inProgress: "[>]",
      pending: "[ ]",
      spinner: ["|", "/", "-", "\\"],
    });

    expect(icons).toEqual({
      completed: "[x]",
      inProgress: "[>]",
      pending: "[ ]",
      spinner: ["|", "/", "-", "\\"],
    });
  });

  it("keeps the default for icons that are not configured", () => {
    const icons = resolveTaskIcons({ pending: "[ ]" });

    expect(icons.pending).toBe("[ ]");
    expect(icons.completed).toBe("✔");
    expect(icons.inProgress).toBe("◼");
    expect(icons.spinner).toEqual(resolveTaskIcons(undefined).spinner);
  });

  it("accepts frames that are more than one glyph", () => {
    const spinner = ["⣾⣾", "🌑\uFE0F", "..", "a\u0301"];

    expect(resolveTaskIcons({ spinner }).spinner).toEqual(spinner);
  });

  it("falls back per icon when a status icon is not a non-empty string", () => {
    const defaults = resolveTaskIcons(undefined);
    const icons = resolveTaskIcons(
      { completed: 42, inProgress: "", pending: "[ ]" } as unknown as TaskIconsConfig,
    );

    expect(icons.completed).toBe(defaults.completed);
    expect(icons.inProgress).toBe(defaults.inProgress);
    expect(icons.pending).toBe("[ ]");
  });

  it("falls back to the default spinner when the configured one is unusable", () => {
    const defaults = resolveTaskIcons(undefined);
    const rejected: unknown[] = [[], "✳✴", null, ["✳", 7], ["✳", ""], {}];

    for (const spinner of rejected) {
      expect(resolveTaskIcons({ spinner } as unknown as TaskIconsConfig).spinner).toEqual(defaults.spinner);
    }
  });

  it("does not let a caller mutate the defaults through a resolved icon set", () => {
    resolveTaskIcons(undefined).spinner.push("boom");

    expect(resolveTaskIcons(undefined).spinner).toHaveLength(11);
  });
});
