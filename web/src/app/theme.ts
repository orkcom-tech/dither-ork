/**
 * Themes — F-UI-09 groundwork.
 *
 * Three modes, two themes. `system` follows the OS, which is the only mode that
 * can change without the user touching anything, so it is a mode rather than a
 * one-off reading of the media query at startup.
 *
 * The resolved theme is stamped on `<html data-theme>`; every colour in the app
 * comes from a custom property defined against that attribute in
 * `src/ui/theme.css`. Nothing anywhere reads a literal colour, which is what
 * makes the rest of F-UI-09 — user-editable, importable themes — a matter of
 * writing values rather than of touching components.
 *
 * The **mode** is persisted and the layout is not, which looks inconsistent and
 * is not: a theme has one value and restoring it wrong is impossible, whereas a
 * partially restored layout is a real hazard and belongs with the rest of step
 * 14 of the build order.
 */

import { logger } from "../lib/log";

const log = logger("app");

export type ThemeMode = "system" | "dark" | "light";
export type Theme = "dark" | "light";

export const THEME_MODES: readonly ThemeMode[] = ["system", "dark", "light"];

const STORAGE_KEY = "dither-ork.theme-mode";

/**
 * What the application opens as before anybody has chosen.
 *
 * `dark`, not `system`. That is the committed default and the reason is in
 * `src/ui/theme/tokens.css`: a light ground around an image raises its apparent
 * contrast and cools its midtones, so a tone decision made against a light
 * chrome does not survive being looked at anywhere else. Following the OS would
 * mean the same document is judged against two different grounds depending on
 * which machine it is opened on, which is exactly the thing a colour tool must
 * not do.
 *
 * Light is still one of the three modes — F-UI-09 requires it — and a user who
 * picks it keeps it. This is the starting point, not a restriction.
 */
export const DEFAULT_MODE: ThemeMode = "dark";

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): Theme {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}

/** Cycle order for the single toolbar control: system → dark → light → system. */
export function nextMode(mode: ThemeMode): ThemeMode {
  const index = THEME_MODES.indexOf(mode);
  return THEME_MODES[(index + 1) % THEME_MODES.length] ?? "system";
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "dark" || value === "light";
}

export function labelForMode(mode: ThemeMode, resolved: Theme): string {
  return mode === "system" ? `Theme: system (${resolved})` : `Theme: ${mode}`;
}

/**
 * Read the stored mode.
 *
 * `localStorage` throws rather than returning null when storage is denied — a
 * Safari private window does exactly that — so the failure is caught, logged
 * and answered with the default. That is a stated degradation, not a silent
 * one: the app still works and the console says the preference will not stick.
 */
export function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_MODE;
    if (isThemeMode(raw)) return raw;
    log.warn("stored theme mode is not one this build knows", { value: raw });
    return DEFAULT_MODE;
  } catch (error) {
    log.warn("theme preference cannot be read from this browser's storage", {
      error: String(error),
    });
    return DEFAULT_MODE;
  }
}

export function storeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch (error) {
    log.warn("theme preference cannot be saved in this browser", {
      error: String(error),
      mode,
    });
  }
}

/** Stamp the resolved theme where the stylesheet can see it. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
}

export interface ThemeController {
  readonly mode: ThemeMode;
  readonly theme: Theme;
  set(mode: ThemeMode): void;
  cycle(): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/**
 * The live theme. One instance per document; the shell creates it.
 *
 * It owns the media-query subscription, so `system` keeps tracking the OS for
 * the whole session rather than only at startup.
 */
export function createThemeController(): ThemeController {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const listeners = new Set<() => void>();

  let mode = readStoredMode();
  let theme = resolveTheme(mode, query.matches);
  applyTheme(theme);
  log.info("theme applied", { mode, theme, prefersDark: query.matches });

  const settle = (reason: string): void => {
    const next = resolveTheme(mode, query.matches);
    if (next === theme) return;
    theme = next;
    applyTheme(theme);
    log.info("theme changed", { reason, mode, theme });
    for (const listener of listeners) listener();
  };

  const onSystemChange = (): void => settle("system-preference");
  query.addEventListener("change", onSystemChange);

  return {
    get mode() {
      return mode;
    },
    get theme() {
      return theme;
    },
    set(next: ThemeMode): void {
      if (next === mode) return;
      mode = next;
      storeMode(mode);
      log.info("theme mode set", { mode });
      settle("user");
      // `settle` only notifies when the resolved theme changed; the mode itself
      // changed either way and the control has to redraw.
      for (const listener of listeners) listener();
    },
    cycle(): void {
      this.set(nextMode(mode));
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      query.removeEventListener("change", onSystemChange);
      listeners.clear();
    },
  };
}
