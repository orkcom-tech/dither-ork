/**
 * Sharing by URL — F-DO-06.
 *
 * Three properties, in order of how much they matter:
 *
 * 1. **The image is never in the link.** Tested against a document that has one
 *    embedded, because that is the only state from which a leak is possible and
 *    therefore the only state worth testing.
 * 2. **The link round trips exactly**, including the parameters a lossy encoder
 *    would flatten.
 * 3. **A damaged link is refused**, not decoded as far as it goes. Truncation is
 *    the normal failure — links get cut by whatever they were pasted through —
 *    and half a stack that renders is worse than an error.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../../lib/log";
import { createDocument } from "../../state/document";
import { addNode, setNodeParam, setPalette, setSource } from "../../state/mutations";
import { testRegistry } from "../../state/fixture";
import type { DitherDocument } from "../../types/document";
import { encodeDorkFile, withEmbeddedSource } from "./dork";
import { DocumentFileError } from "./errors";
import { presetFromDocument, type Preset } from "./preset";
import {
  SHARE_ENCODING_VERSION,
  SHARE_FRAGMENT_KEY,
  decodeSharePayload,
  encodeShareFragmentFor,
  encodeSharePayload,
  sharePayloadInHash,
  shareUrl,
} from "./share";

setLevel("error");

const registry = testRegistry();

const IDENTITY = {
  id: "p1",
  name: "Shared stack",
  createdAt: "2026-08-07T12:00:00.000Z",
} as const;

function sample(): DitherDocument {
  const levels = addNode(createDocument(), registry, "test-levels");
  const diffusion = addNode(levels.document, registry, "test-diffusion");
  let document = setNodeParam(diffusion.document, registry, levels.nodeId, "mode", "log");
  document = setNodeParam(document, registry, levels.nodeId, "amount", 1.25);
  document = setPalette(document, {
    id: "duo",
    name: "Duo",
    colors: [0, 0, 0, 255, 128, 0],
    metric: "srgb",
  });
  return setSource(document, { name: "photo.png", width: 800, height: 600 });
}

function preset(): Preset {
  return presetFromDocument(sample(), IDENTITY);
}

describe("the image is never in the link", () => {
  it("is absent even when the document has one embedded", async () => {
    // A self-contained `.dork` is open and its base64 is sitting in the
    // document. This is the only state a leak could come from.
    const embedded = withEmbeddedSource(sample(), "data:image/png;base64,iVBORw0KGgoAAAA=");
    const payload = await encodeShareFragmentFor(embedded, IDENTITY);
    const back = await decodeSharePayload(payload, registry);
    expect(back.document.source).toBeNull();
  });

  it("does not carry the file name either", async () => {
    const payload = await encodeShareFragmentFor(sample(), IDENTITY);
    const back = await decodeSharePayload(payload, registry);
    expect(JSON.stringify(back.document)).not.toContain("photo.png");
  });
});

describe("round trip", () => {
  it("returns the same preset", async () => {
    const payload = await encodeSharePayload(preset());
    expect(await decodeSharePayload(payload, registry)).toEqual(preset());
  });

  it("returns a document that encodes to the same bytes", async () => {
    const payload = await encodeSharePayload(preset());
    const back = await decodeSharePayload(payload, registry);
    expect(encodeDorkFile(back.document)).toBe(encodeDorkFile(preset().document));
  });

  it("is smaller than the JSON it carries", async () => {
    // Not a performance assertion: the compression is what decides whether a
    // link survives the application it is pasted through, so a change that
    // silently stopped compressing should fail here.
    const payload = await encodeSharePayload(preset());
    expect(payload.length).toBeLessThan(JSON.stringify(preset()).length);
  });

  it("uses no character a URL treats specially", async () => {
    const payload = await encodeSharePayload(preset());
    expect(payload).toMatch(/^[0-9]+\.[A-Za-z0-9_-]+$/);
  });
});

describe("refusals", () => {
  it("refuses a link with no version in front of it", async () => {
    await expect(decodeSharePayload("abcdef", registry)).rejects.toBeInstanceOf(
      DocumentFileError,
    );
  });

  it("refuses an encoding from a newer build rather than reading the bytes", async () => {
    const payload = await encodeSharePayload(preset());
    const bumped = `${SHARE_ENCODING_VERSION + 1}.${payload.split(".")[1] ?? ""}`;
    try {
      await decodeSharePayload(bumped, registry);
      throw new Error("accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentFileError);
      expect((error as DocumentFileError).code).toBe("future-schema");
    }
  });

  it("refuses a truncated link", async () => {
    const payload = await encodeSharePayload(preset());
    const cut = payload.slice(0, Math.floor(payload.length * 0.6));
    await expect(decodeSharePayload(cut, registry)).rejects.toBeInstanceOf(
      DocumentFileError,
    );
  });

  it("refuses an empty payload", async () => {
    await expect(decodeSharePayload("   ", registry)).rejects.toBeInstanceOf(
      DocumentFileError,
    );
  });
});

describe("the URL", () => {
  it("puts the payload in the fragment, which never reaches a server", () => {
    const url = shareUrl("https://example.invalid/app/", "1.abc");
    expect(url).toBe(`https://example.invalid/app/#${SHARE_FRAGMENT_KEY}=1.abc`);
  });

  it("drops whatever query the sender's page happened to have", () => {
    const url = shareUrl("https://example.invalid/app/?debug=1&token=secret", "1.abc");
    expect(url).not.toContain("token");
    expect(url).not.toContain("debug");
  });

  it("replaces a fragment rather than appending to one", () => {
    const url = shareUrl("https://example.invalid/app/#p=1.old", "1.new");
    expect(url).toBe(`https://example.invalid/app/#${SHARE_FRAGMENT_KEY}=1.new`);
  });

  it("finds the payload in a location hash", () => {
    expect(sharePayloadInHash("#p=1.abc")).toBe("1.abc");
    expect(sharePayloadInHash("p=1.abc")).toBe("1.abc");
    expect(sharePayloadInHash("#other=x&p=1.abc")).toBe("1.abc");
  });

  it("finds nothing in a hash that carries none", () => {
    expect(sharePayloadInHash("")).toBeNull();
    expect(sharePayloadInHash("#")).toBeNull();
    expect(sharePayloadInHash("#section-two")).toBeNull();
    expect(sharePayloadInHash("#p=")).toBeNull();
  });

  it("survives the round trip through a real URL", async () => {
    const payload = await encodeSharePayload(preset());
    const url = new URL(shareUrl("https://example.invalid/app/", payload));
    const back = sharePayloadInHash(url.hash);
    expect(back).not.toBeNull();
    expect(await decodeSharePayload(back ?? "", registry)).toEqual(preset());
  });
});
