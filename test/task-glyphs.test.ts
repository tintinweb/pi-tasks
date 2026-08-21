import { describe, expect, it } from "vitest";
import { resolveTaskGlyphs, type TaskGlyphsConfig } from "../src/task-glyphs.js";

describe("resolveTaskGlyphs", () => {
  it("returns the built-in glyphs when nothing is configured", () => {
    const glyphs = resolveTaskGlyphs(undefined);

    expect(glyphs).toEqual({
      completed: "✔",
      inProgress: "◼",
      pending: "◻",
      spinner: ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"],
      completedSummary: "✔",
      header: "●",
      overflow: "…",
      blocked: "›",
      inputTokens: "↑",
      outputTokens: "↓",
      statsSeparator: "·",
      trailingEllipsis: "…",
      truncation: "...",
    });
  });

  it("returns the built-in glyphs for an empty glyph object", () => {
    expect(resolveTaskGlyphs({})).toEqual(resolveTaskGlyphs(undefined));
  });

  it("applies every configured glyph", () => {
    const configured: TaskGlyphsConfig = {
      completed: "[x]",
      inProgress: "[>]",
      pending: "[ ]",
      spinner: ["|", "/", "-", "\\"],
      completedSummary: "[=]",
      header: "*",
      overflow: "~",
      blocked: ">",
      inputTokens: "in",
      outputTokens: "out",
      statsSeparator: "|",
      trailingEllipsis: "~~",
      truncation: ">>",
    };

    expect(resolveTaskGlyphs(configured)).toEqual(configured);
  });

  it("keeps the default for glyphs that are not configured", () => {
    const defaults = resolveTaskGlyphs(undefined);
    const glyphs = resolveTaskGlyphs({ pending: "[ ]" });

    expect(glyphs.pending).toBe("[ ]");
    expect(glyphs.completed).toBe(defaults.completed);
    expect(glyphs.header).toBe(defaults.header);
    expect(glyphs.spinner).toEqual(defaults.spinner);
  });

  it("falls back per glyph when a value is not a non-empty string", () => {
    const defaults = resolveTaskGlyphs(undefined);
    const glyphs = resolveTaskGlyphs(
      { completed: 42, inProgress: "", blocked: null, pending: "[ ]" } as unknown as TaskGlyphsConfig,
    );

    expect(glyphs.completed).toBe(defaults.completed);
    expect(glyphs.inProgress).toBe(defaults.inProgress);
    expect(glyphs.blocked).toBe(defaults.blocked);
    expect(glyphs.pending).toBe("[ ]");
  });

  it("accepts a single space, which renders as spacing only", () => {
    expect(resolveTaskGlyphs({ blocked: " " }).blocked).toBe(" ");
  });

  describe("completedSummary", () => {
    it("follows `completed` when only `completed` is set", () => {
      expect(resolveTaskGlyphs({ completed: "[x]" }).completedSummary).toBe("[x]");
    });

    it("wins over `completed` when set explicitly", () => {
      const glyphs = resolveTaskGlyphs({ completed: "[x]", completedSummary: "[=]" });

      expect(glyphs.completed).toBe("[x]");
      expect(glyphs.completedSummary).toBe("[=]");
    });

    it("falls back through `completed` to the default when both are unusable", () => {
      const glyphs = resolveTaskGlyphs({ completed: "", completedSummary: "" });

      expect(glyphs.completedSummary).toBe("✔");
    });
  });

  describe("spinner", () => {
    it("accepts frames that are more than one glyph", () => {
      const spinner = ["⣾⣾", "🌑\uFE0F", "..", "a\u0301"];

      expect(resolveTaskGlyphs({ spinner }).spinner).toEqual(spinner);
    });

    it("falls back as a whole when the configured sequence is unusable", () => {
      const defaults = resolveTaskGlyphs(undefined);
      const rejected: unknown[] = [[], "✳✴", null, ["✳", 7], ["✳", ""], {}];

      for (const spinner of rejected) {
        expect(resolveTaskGlyphs({ spinner } as unknown as TaskGlyphsConfig).spinner)
          .toEqual(defaults.spinner);
      }
    });
  });
});
