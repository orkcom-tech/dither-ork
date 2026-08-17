/**
 * The live document, and the path from it to a picture.
 *
 * ```ts
 * const session = await createEditorSession({ registry, report, viewport });
 * const snapshot = React.useSyncExternalStore(
 *   session.store.subscribe,
 *   session.store.getSnapshot,
 * );
 * session.store.addNode("floyd-steinberg");
 * session.store.setNodeParam(id, "strength", 0.8, { continuous: true });
 * session.store.undo();
 * ```
 *
 * What lives where:
 *
 * - `document.ts`  building a document; the defaults a new one opens with.
 * - `mutations.ts` every way a document changes, as pure functions.
 * - `history.ts`   unlimited undo/redo (F-ST-04).
 * - `store.ts`     the live document, its selection, and who is told when it moves.
 * - `serialize.ts` `.dork` out and in, with the refusals F-DO-08 requires.
 * - `autosave.ts`  OPFS autosave and the restore notice (F-DO-07).
 * - `render/`      document -> graph -> frame.
 * - `session.ts`   the one call that assembles all of it.
 */

export {
  DEFAULT_CLOCK,
  DEFAULT_PALETTE,
  createDocument,
  createStackNode,
  nextNodeId,
  seedForNodeId,
} from "./document";

export { DocumentError, type DocumentErrorCode } from "./errors";

export { History, type HistoryEntry } from "./history";

export {
  addNode,
  connectNodes,
  disconnectPort,
  duplicateNode,
  maskNodeWith,
  moveNode,
  removeNode,
  requireNode,
  setBindings,
  setClock,
  setNodeBlend,
  setNodeEnabled,
  setNodeMask,
  setNodeOpacity,
  setNodeParam,
  setOutputNode,
  setPalette,
  setSource,
} from "./mutations";

export { decodeDocument, encodeDocument } from "./serialize";

export {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_FILE_NAME,
  AutosaveWriter,
  encodeAutosave,
  hasOpfs,
  loadAutosave,
  opfsAutosaveStorage,
  type AutosaveRecord,
  type AutosaveStorage,
  type RestoredAutosave,
} from "./autosave";

export {
  DocumentStore,
  restoreNotice,
  type CommitOptions,
  type DocumentSnapshot,
  type DocumentStoreOptions,
  type RestoreNotice,
} from "./store";

export { createEditorSession, type EditorSession, type EditorSessionOptions } from "./session";

// `render/` is deliberately **not** re-exported here.
//
// Every module in it — the device, the core, the backends, the renderer —
// belongs to the render worker, and re-exporting them from the barrel the shell
// imports would pull the whole render path, its shaders and the WASM glue into
// the main-thread bundle for the sake of a type. The worker imports
// `state/render` directly; `session.ts` holds a `RenderService` and nothing
// else. `buildRenderGraph` is pure and is imported from `state/render/graph` by
// the two tests that cover it.
