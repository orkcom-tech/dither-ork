/**
 * How big a node card is, and how far apart two of them sit.
 *
 * One module for the numbers, because three others need them and none of them
 * may disagree: {@link layoutGraph} spaces columns and rows by them,
 * `geometry.ts` puts a port at a point derived from them, and `graph.css` draws
 * a card that has to be exactly that size or every wire lands beside its port
 * rather than on it.
 *
 * They reach the DOM as **inline styles** on the card and its port rows rather
 * than as sizes in `graph.css`. That is deliberate: a card sized by the
 * stylesheet would be one copy of these numbers, the layout that spaced it would
 * be another, and the two are invisible to each other until somebody changes
 * one — at which point every wire in the application lands two pixels beside its
 * port. The stylesheet styles; this file measures.
 *
 * All values are **world units**: CSS pixels at zoom 1. The view transform
 * scales them; nothing here knows about it.
 */

/**
 * Card width.
 *
 * Set by the widest header the catalogue produces rather than chosen: a node id,
 * the effect's name, the slot badge — the longest of which is `dither` — and the
 * execution badge, all on one line. Narrower than this and "Bayer 4×4" arrives
 * as "Bayer …", which makes two effects in the same family indistinguishable
 * without clicking each of them in turn.
 */
export const NODE_WIDTH = 200;

/** The title row: name, badges, and the marks for enabled and output. */
export const NODE_HEADER_HEIGHT = 34;

/** One input port's row. The output port shares the first one. */
export const PORT_ROW_HEIGHT = 18;

/** Below the last port row, so a card is not flush with its own edge. */
export const NODE_PAD_BOTTOM = 8;

/** Horizontal gap between one column of cards and the next. */
export const COLUMN_GAP = 64;

/** Vertical gap between rows. */
export const ROW_GAP = 22;

/**
 * How far from a port a wire may be dropped and still land on it.
 *
 * The whole of "connecting must be forgiving". It is a radius in world units
 * measured from the port's own point, and it is deliberately larger than the
 * port: a port row is 18 units tall and a person aiming at one with a wire in
 * hand is aiming at a label, not at a dot. Anything nearer than this wins;
 * beyond it the drop is on the background and the wire is abandoned.
 *
 * Chosen as a little under half a column gap so that two adjacent cards can
 * never both claim a point — the nearest wins, and "nearest" is unambiguous.
 */
export const SNAP_RADIUS = 30;

/** A card's height, which is a function of how many input ports it declares. */
export function nodeHeight(portCount: number): number {
  // At least one row even for a node that declares nothing, because the output
  // port lives on the first row and a card with no rows would have nowhere to
  // put it. No effect in the catalogue is portless — a source generator still
  // gets the universal mask port — but the layout must not depend on that.
  const rows = portCount < 1 ? 1 : portCount;
  return NODE_HEADER_HEIGHT + rows * PORT_ROW_HEIGHT + NODE_PAD_BOTTOM;
}

/** Where one port row's centre sits, measured down from the card's top. */
export function portOffsetY(index: number): number {
  return NODE_HEADER_HEIGHT + index * PORT_ROW_HEIGHT + PORT_ROW_HEIGHT / 2;
}
