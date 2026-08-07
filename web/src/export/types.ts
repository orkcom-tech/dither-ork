/**
 * What a still export is, as types.
 *
 * Three formats (F-EX-01 PNG, F-EX-02 JPEG, F-EX-03 WebP), one integer scale
 * multiplier (F-EX-12), one quality control, and a result that says what
 * actually happened rather than only handing back bytes.
 *
 * ## The frame is already sRGB, and that is the point
 *
 * The pipeline is linear light end to end and the transfer is reapplied exactly
 * once, by whoever produces a frame (`io/linear.ts`, `viewport/frame.ts`). The
 * renderer already does that on the way to the screen, so **export encodes the
 * same bytes the viewport draws**. That is not a shortcut around
 * docs/ARCHITECTURE.md's "preview and export share one graph" — it is the
 * strongest possible form of it: there is not merely one graph, there is one
 * frame, so the file cannot differ from the picture.
 *
 * ## Why the scale multiplier is not a render resolution
 *
 * F-EX-12 asks for an integer multiplier with nearest-neighbour, independent of
 * preview zoom. Re-running the graph at 4x would be a *different picture* — a
 * dither is a function of the pixel grid it ran on, which is the same reason
 * `io/limits.ts` refuses to resample a source. So the multiplier is applied to
 * the finished frame, by pixel replication, and every output pixel is a copy of
 * a pixel that was on screen.
 */

/**
 * A byte buffer this module allocated and owns.
 *
 * `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`, which since
 * TypeScript 5.7 means `Uint8Array<ArrayBufferLike>` and so might be backed by
 * a `SharedArrayBuffer`. `Blob` and the stream writers refuse that, correctly —
 * a shared buffer can be written from another thread while they are reading it
 * — and a `SharedArrayBuffer` is very much in scope here, since cross-origin
 * isolation is mandatory so that the WASM thread pool can exist
 * (docs/ARCHITECTURE.md, "Cross-origin isolation").
 *
 * Everything in this directory is allocated with `new Uint8Array(n)`, which is
 * exactly this type. Naming it is what lets an encoder's output reach a `Blob`
 * without a cast standing in for the fact.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * The still formats F-EX-01 through F-EX-03 name, plus F-EX-08's SVG.
 *
 * SVG is in the same union rather than beside it because everything the panel
 * does with a format — name the file, choose the destination, measure the size,
 * report the result — is the same operation for a vector file as for a raster
 * one. What differs is stated as data on {@link ExportFormatInfo}: `vector`
 * turns off the pixel multiplier, which has no meaning for a document with no
 * pixel grid.
 */
export type ExportFormat = "png" | "jpeg" | "webp" | "svg";

export interface ExportFormatInfo {
  readonly id: ExportFormat;
  readonly label: string;
  readonly mime: string;
  /** Without the dot. */
  readonly extension: string;
  /** Whether the container can carry an alpha channel at all. JPEG cannot. */
  readonly alpha: boolean;
  /** Whether the quality control does anything (F-EX-02). PNG is lossless. */
  readonly lossy: boolean;
  /**
   * True for a format with no pixel grid.
   *
   * F-EX-12's multiplier replicates pixels, and a vector document has none to
   * replicate — its size is whatever it is rendered at. The panel hides the
   * control rather than showing one that would do nothing, which is the same
   * rule the stack row applies to a composite on a resampling node.
   */
  readonly vector: boolean;
  /** One line a person reads before choosing it. */
  readonly detail: string;
}

/** Which of F-EX-09's two output modes the tracer emits. */
export type TraceMode = "pixel-perfect" | "simplified";

/**
 * The tracer's controls (F-EX-09, F-EX-10).
 *
 * Every field is read by exactly one mode and the panel says which, so a value
 * that is currently ignored is visibly ignored rather than quietly so:
 * `tolerance` only in `simplified`, `strokeWidth` only when `strokeOnly` is on.
 * They are kept across a mode change for the same reason `quality` is kept
 * across a format change — switching a mode on and off must not lose a setting.
 */
export interface VectorTraceSettings {
  readonly mode: TraceMode;
  /** Douglas-Peucker tolerance in pixels. Vertices are dropped, never moved. */
  readonly tolerance: number;
  /**
   * Minimum feature size, in whole pixels of area (F-EX-10). Regions below it
   * are removed and enclosed holes below it are filled. 0 and 1 are both
   * no-ops, since no connected region has an area under one pixel.
   */
  readonly minFeatureArea: number;
  /** Outlines only — `fill="none"` plus a stroke — for a cutter (F-EX-10). */
  readonly strokeOnly: boolean;
  /** Stroke width in pixel units. */
  readonly strokeWidth: number;
}

/** Everything the export panel decides. */
export interface ExportSettings {
  readonly format: ExportFormat;
  /**
   * 1..100, read only by the formats whose {@link ExportFormatInfo.lossy} is
   * true. Kept across a format change so switching to JPEG and back does not
   * silently reset it.
   */
  readonly quality: number;
  /** Integer multiplier, nearest-neighbour (F-EX-12). Never the preview zoom. */
  readonly scale: number;
  /** Read only by the vector formats. Kept across a format change. */
  readonly trace: VectorTraceSettings;
}

/**
 * A finished frame, exactly as the viewport was given it: interleaved 8-bit
 * sRGB RGBA with unassociated alpha, `width * height * 4` bytes.
 */
export interface ExportFrame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/**
 * The frame after the scale multiplier and, where the format has no alpha, the
 * matte flatten. This is what an encoder is handed.
 */
export interface ExportRaster {
  readonly width: number;
  readonly height: number;
  readonly data: Bytes;
  /** True when {@link flattenOntoMatte} ran, so the UI can say it did. */
  readonly flattened: boolean;
  /** Set when the frame carried transparency, whether or not it was flattened. */
  readonly hadTransparency: boolean;
}

/** An indexed image: what F-EX-01's "indexed when the output is indexed" means. */
export interface IndexedImage {
  readonly width: number;
  readonly height: number;
  /** One palette index per pixel, row-major, one byte each before packing. */
  readonly indices: Bytes;
  /** Packed RGBA palette entries, `count * 4` bytes. */
  readonly palette: Bytes;
  readonly count: number;
  /**
   * How many leading entries have alpha below 255. Entries are ordered so those
   * come first, which is exactly the length of the `tRNS` chunk PNG then needs —
   * the chunk may be shorter than the palette and the missing entries are opaque
   * by definition.
   */
  readonly transparentEntries: number;
  /** 1, 2, 4 or 8 — the smallest that addresses {@link count} entries. */
  readonly bitDepth: 1 | 2 | 4 | 8;
}

/**
 * What tracing an index map actually did.
 *
 * Carried out of the core rather than logged there, for the reason docs/API.md
 * gives about `ExtractedPalette`: `dither-core` has no logger. The two dropped
 * counts and `uncoveredPixels` are the ones a person needs — they are the
 * difference between "the tracer lost my detail" and "the minimum feature size
 * you set removed 412 specks".
 */
export interface VectorTraceReport {
  /** Groups emitted — one per palette colour that survived into the output. */
  readonly layers: number;
  /** Closed subpaths across every group, holes included. */
  readonly contours: number;
  /** Vertices emitted. The document is very nearly a function of this. */
  readonly points: number;
  /** Contours simplification collapsed, and which were dropped rather than emitted. */
  readonly contoursDropped: number;
  /** Connected regions removed by `minFeatureArea`. */
  readonly regionsDropped: number;
  readonly regionPixelsDropped: number;
  /** Enclosed holes filled in by `minFeatureArea`. */
  readonly holesFilled: number;
  readonly holePixelsFilled: number;
  /** Pixels of the source no emitted layer covers. Zero when the filter is off. */
  readonly uncoveredPixels: number;
}

/** What an export produced. Every field is a fact the UI states rather than infers. */
export interface ExportResult {
  readonly blob: Blob;
  readonly format: ExportFormat;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /** True when the PNG came out as colour type 3. Always false for JPEG/WebP. */
  readonly indexed: boolean;
  /** Palette entries written, when {@link indexed}. Zero otherwise. */
  readonly paletteEntries: number;
  /** True when transparency was flattened onto the matte because JPEG has none. */
  readonly flattened: boolean;
  /** Set for a vector export, `null` for a raster one. */
  readonly trace: VectorTraceReport | null;
  readonly ms: number;
}
