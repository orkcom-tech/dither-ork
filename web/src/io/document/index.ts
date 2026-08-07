/**
 * Documents, presets and sharing — F-DO-01 to F-DO-06 and F-DO-08.
 *
 * ```ts
 * // save the open document (F-DO-01)
 * downloadTextFile(documentFileName(doc), encodeDorkFile(doc), DORK_MIME);
 *
 * // save it with the picture inside (F-DO-02)
 * const embedded = withEmbeddedSource(doc, await encodeSourceDataUrl(image));
 *
 * // open one back
 * const doc = parseDorkFile(await readTextFile(file), registry, file.name);
 * if (isSelfContained(doc)) await session.openFile(embeddedSourceFile(doc));
 *
 * // presets (F-DO-03, F-DO-05)
 * const library = await PresetLibrary.open({ storage: opfsPresetStorage(), registry });
 * await library.save("Chunky", doc);
 * const next = applyPreset(library.get(id)!, doc);
 *
 * // share by URL (F-DO-06) — the image is not in it and cannot be
 * const link = shareUrl(location.href, await encodeSharePayload(preset));
 * ```
 *
 * ## What lives where
 *
 * - `file.ts`     which of the two shapes a file is, and JSON that is not JSON.
 * - `dork.ts`     the `.dork` file: canonical bytes, naming, the two variants.
 * - `preset.ts`   a preset is a document with no picture; its file format.
 * - `library.ts`  browse, apply, rename, delete, import, export; OPFS storage.
 * - `starter.ts`  the shipped starter set (F-DO-04) — read its header first.
 * - `share.ts`    the URL fragment, which is the part that never reaches a server.
 * - `base64.ts`   bytes to text, in the two alphabets the two destinations need.
 * - `embed.ts`    the image in and out of a self-contained document. Needs a canvas.
 * - `browser.ts`  download, read, clipboard. The only other module that touches the DOM.
 *
 * ## Three properties the types cannot state
 *
 * - **Nothing here re-implements document validation.** Both `parseDorkFile` and
 *   `decodePreset` end in `decodeDocument`, so every refusal F-DO-08 requires —
 *   a newer schema, an effect this build lacks, a binding pointing at no node —
 *   happens once, in `state/serialize.ts`, and cannot drift into two opinions.
 * - **`encodeDorkFile` is canonical.** The bytes depend on the document's values
 *   and not on the order its fields were assigned, so save → load → save is
 *   byte-identical by construction rather than by luck.
 * - **A share link cannot carry an image.** What is encoded is a `Preset`, whose
 *   `document.source` is `null` on the way in and refused if it is not on the
 *   way out. There is no path from an open picture to a URL.
 */

export { DocumentFileError, type DocumentFileErrorCode } from "./errors";

export {
  PRESET_FILE_KIND,
  isRecord,
  parseJsonObject,
  sniffDorkFile,
  type DorkFileKind,
  type SniffedDorkFile,
} from "./file";

export {
  DORK_ACCEPT,
  DORK_EXTENSION,
  DORK_MIME,
  canonicalDocument,
  decodeSniffedDocument,
  documentFileName,
  encodeDorkFile,
  isSelfContained,
  parseDorkFile,
  safeFileStem,
  withEmbeddedSource,
  withoutEmbeddedSource,
} from "./dork";

export {
  PRESET_EXTENSION,
  PRESET_FILE_SCHEMA_VERSION,
  PRESET_MIME,
  applyPreset,
  decodePreset,
  decodePresetFile,
  decodePresetRecord,
  documentFromPreset,
  encodePresetFile,
  nextPresetId,
  presetFromDocument,
  requireName,
  type Preset,
  type PresetIdentity,
} from "./preset";

export {
  PRESET_LIBRARY_FILE_NAME,
  PresetLibrary,
  hasPresetStorage,
  opfsPresetStorage,
  type PresetLibraryOptions,
  type PresetStorage,
} from "./library";

export {
  STARTER_PRESETS,
  buildStarterPresets,
  type StarterPresetSpec,
} from "./starter";

export {
  SHARE_ENCODING_VERSION,
  SHARE_FRAGMENT_KEY,
  SHARE_LINK_WARNING_CHARS,
  decodeSharePayload,
  encodeShareFragmentFor,
  encodeSharePayload,
  sharePayloadInHash,
  shareUrl,
} from "./share";

export {
  base64Decode,
  base64Encode,
  base64UrlDecode,
  base64UrlEncode,
  encodeDataUrl,
  parseDataUrl,
  type DataUrl,
} from "./base64";

export { EMBEDDED_IMAGE_MIME, embeddedSourceFile, encodeSourceDataUrl } from "./embed";

export { copyToClipboard, downloadTextFile, readTextFile } from "./browser";
