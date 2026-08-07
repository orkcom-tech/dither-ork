import React from "react";
import { createRoot } from "react-dom/client";

import type { EffectRegistry } from "../../registry";
import { createHelpController, type HelpController } from "./controller";
import type { DwellTiming } from "./dwell";
import { HelpLayer } from "./HelpLayer";
import { helpToken, type HelpTarget } from "./target";

/**
 * Turning contextual help on — one call, and the whole feature exists.
 *
 * ```ts
 * import { installHelp } from "../ui/help";
 * const removeHelp = installHelp({ registry });
 * ```
 *
 * A root of its own rather than a component in the shell, for the same reason
 * the controller delegates from the document: help is about *any* control in the
 * application, including ones drawn by panels that are mounted and unmounted
 * around it, and a panel that lives inside one of those regions would be
 * unmounted along with it. It is also what keeps this feature out of `App.tsx`
 * entirely.
 *
 * Nothing is drawn until a control with help on it is dwelt on, so installing it
 * against a build where no call site has been annotated yet costs one empty
 * `<div>` and a handful of listeners, and shows nothing — which is the honest
 * behaviour rather than an empty panel.
 */
export interface InstallHelpOptions {
  readonly registry: EffectRegistry;
  /** Where the panel's root goes. Defaults to `document.body`. */
  readonly container?: HTMLElement;
  /** The window whose events are listened to. Defaults to `window`. */
  readonly scope?: Window;
  /** Dwell and grace, for anyone who wants them different. */
  readonly timing?: DwellTiming;
}

export function installHelp(options: InstallHelpOptions): () => void {
  const scope = options.scope ?? window;
  const container = options.container ?? scope.document.body;

  // Built with a conditional rather than `timing: options.timing`, because
  // `exactOptionalPropertyTypes` makes an explicit `undefined` a different thing
  // from an absent field.
  const controller: HelpController = createHelpController(
    options.timing === undefined
      ? { registry: options.registry }
      : { registry: options.registry, timing: options.timing },
  );

  const host = scope.document.createElement("div");
  host.className = "help-host";
  container.appendChild(host);

  const root = createRoot(host);
  root.render(<HelpLayer controller={controller} />);

  const detach = controller.attach(scope);

  return () => {
    detach();
    root.unmount();
    host.remove();
  };
}

/**
 * Attach help to an element that is not a JSX element of yours.
 *
 * For a ref callback, or for anything rendered by a library that will not
 * forward a `data-*` prop. Returns the remover.
 *
 * ```ts
 * <div ref={(el) => (el === null ? undefined : bindHelp(el, { kind: "concept", concept: "stack" }))} />
 * ```
 */
export function bindHelp(element: Element, target: HelpTarget): () => void {
  const previous = element.getAttribute("data-help");
  element.setAttribute("data-help", helpToken(target));
  return () => {
    if (previous === null) element.removeAttribute("data-help");
    else element.setAttribute("data-help", previous);
  };
}
