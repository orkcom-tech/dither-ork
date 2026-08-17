/**
 * Schema migrations — the half of F-DO-08 that had no work to do until now.
 *
 * The mechanism has always existed: `state/serialize.ts` refuses a schema newer
 * than this build understands, and refused an older one too, because schema 1
 * was the only version there had ever been. There is a second now, so this is
 * the migration.
 *
 * ## What changed, and why it is a migration rather than a defaulted field
 *
 * Schema 1 is a **linear stack**: an array of nodes where node *i* reads node
 * *i-1* and the last one is the picture. The wiring is not written down — it is
 * the array order. Schema 2 writes it down, as `edges` and `output`, because a
 * graph has neither an implied predecessor nor a last element.
 *
 * That could have been a default computed at read time and never saved. It is
 * not, and the reason is the thing this file exists to make true: **a schema-1
 * document loads as a chain, and re-saving it produces a schema-2 document that
 * is the same picture.** A default computed on the way in and dropped on the
 * way out means every save silently re-derives the wiring, and the day the
 * derivation changes, every old document changes with it.
 *
 * ## What a migration is allowed to do
 *
 * Add what the new schema needs and change nothing else. No parameter is
 * touched, no id is rewritten, no node is dropped, no default is filled in.
 * `migrate.test.ts` and `registry/document-round-trip.test.ts` hold the line
 * that matters: load an old document, save it, load it again, and the graph and
 * every node's content hash are identical. A format that loses a parameter is
 * worse than no format.
 */

import {
  DOCUMENT_SCHEMA_LINEAR_STACK,
  DOCUMENT_SCHEMA_VERSION,
} from "../../types/document";
import { PRIMARY_INPUT_PORT } from "../../types/registry";
import { logger } from "../../lib/log";
import { DocumentFileError } from "./errors";

const log = logger("io");

/** A JSON object, before anything has been asserted about its fields. */
type RawDocument = Record<string, unknown>;

/**
 * Bring a parsed `.dork` object up to {@link DOCUMENT_SCHEMA_VERSION}.
 *
 * Runs **before** shape validation, on the raw JSON, and that ordering is
 * deliberate: the validator checks the current schema and only the current
 * schema, so it has one shape to describe rather than one per version with the
 * differences threaded through every field.
 *
 * Returns the object unchanged when it is already current. Refuses a version it
 * has no path from, rather than reading it as far as it goes.
 */
export function migrateDocument(raw: RawDocument, schema: number): RawDocument {
  if (schema === DOCUMENT_SCHEMA_VERSION) return raw;

  if (schema === DOCUMENT_SCHEMA_LINEAR_STACK) {
    const migrated = linearStackToGraph(raw);
    log.info("document migrated", {
      from: schema,
      to: DOCUMENT_SCHEMA_VERSION,
      nodes: Array.isArray(migrated["stack"]) ? migrated["stack"].length : 0,
      edges: Array.isArray(migrated["edges"]) ? migrated["edges"].length : 0,
    });
    return migrated;
  }

  throw new DocumentFileError(
    "unrecognised-file",
    `this document is schema ${schema} and this build has no migration from it. ` +
      `Known versions are ${DOCUMENT_SCHEMA_LINEAR_STACK} (linear stack) and ${DOCUMENT_SCHEMA_VERSION} (graph).`,
  );
}

/**
 * Schema 1 to schema 2: write down the wiring the array order implied.
 *
 * Every existing document, preset and share link is one of these, so the
 * translation has to be exactly the semantics the old renderer had, which are
 * stated in one line of the old `state/render/graph.ts`: *"node i reads node
 * i-1, and node 0 reads nothing, which `prepareGraph` reads as 'this node is a
 * root and takes the decoded source'."*
 *
 * So: one edge per adjacent pair on the `in` port, no edge into the first node,
 * and the output is the last node. A **disabled** node is wired like any other,
 * for the same reason it always was — `prepareGraph` resolves a disabled node's
 * edge past it, so the chain stays intact and toggling one does not rebuild the
 * graph. Dropping it here would change what re-enabling it does.
 *
 * An empty stack migrates to no edges and a `null` output, which is what an
 * empty document is.
 */
function linearStackToGraph(raw: RawDocument): RawDocument {
  const stack = raw["stack"];
  if (!Array.isArray(stack)) {
    throw new DocumentFileError(
      "unrecognised-file",
      "this document is schema 1 and its stack is not an array, so there is no chain to migrate",
    );
  }

  const ids: string[] = [];
  for (const [index, node] of stack.entries()) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      throw new DocumentFileError(
        "unrecognised-file",
        `this document is schema 1 and stack[${index}] is not an object, so its position in the chain cannot be turned into an edge`,
      );
    }
    const id: unknown = (node as RawDocument)["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new DocumentFileError(
        "unrecognised-file",
        `this document is schema 1 and stack[${index}] has no id; an edge has to name both of its ends`,
      );
    }
    ids.push(id);
  }

  const edges = ids.slice(1).map((to, index) => ({
    from: ids[index] as string,
    to,
    port: PRIMARY_INPUT_PORT,
  }));

  return {
    ...raw,
    schema: DOCUMENT_SCHEMA_VERSION,
    edges,
    output: ids[ids.length - 1] ?? null,
  };
}
