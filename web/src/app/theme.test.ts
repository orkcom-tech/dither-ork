import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODE,
  THEME_MODES,
  isThemeMode,
  labelForMode,
  nextMode,
  resolveTheme,
} from "./theme";

describe("the default mode", () => {
  /**
   * A guard rather than a tautology. Dark is a decision made for a stated
   * reason — a light ground around an image raises its apparent contrast and
   * cools its midtones, so the same document is judged differently on two
   * machines if the app follows the OS. This test is what makes changing that
   * back to `system` a deliberate act with a failing test attached, rather than
   * a tidy-up nobody notices.
   */
  it("opens dark rather than following the operating system", () => {
    expect(DEFAULT_MODE).toBe("dark");
    expect(resolveTheme(DEFAULT_MODE, false)).toBe("dark");
  });

  it("is still one of the modes the control can cycle to", () => {
    expect(THEME_MODES).toContain(DEFAULT_MODE);
  });
});

describe("resolveTheme", () => {
  it("follows the system preference in system mode", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("ignores the system preference once the user has chosen", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("nextMode", () => {
  it("cycles through every mode and returns to the start", () => {
    let mode = THEME_MODES[0] ?? "system";
    const seen = [mode];
    for (let i = 0; i < THEME_MODES.length - 1; i += 1) {
      mode = nextMode(mode);
      seen.push(mode);
    }
    expect(seen).toEqual([...THEME_MODES]);
    expect(nextMode(mode)).toBe(THEME_MODES[0]);
  });
});

describe("isThemeMode", () => {
  it("accepts only the three modes, so a stale stored value cannot be applied", () => {
    expect(isThemeMode("dark")).toBe(true);
    expect(isThemeMode("system")).toBe(true);
    expect(isThemeMode("solarized")).toBe(false);
    expect(isThemeMode(null)).toBe(false);
  });
});

describe("labelForMode", () => {
  it("says what system mode actually resolved to", () => {
    expect(labelForMode("system", "dark")).toBe("Theme: system (dark)");
    expect(labelForMode("light", "light")).toBe("Theme: light");
  });
});
