/**
 * F-DO-07 — the record, the debounce and the restore.
 *
 * The OPFS handles themselves are not tested here: `navigator.storage` has no
 * meaning in a Node process, and a hand-written stand-in for it would only
 * prove that the stand-in works. What *is* tested is everything above the
 * storage interface — which is where the behaviour the requirement names lives.
 */

import { describe, expect, it, vi } from "vitest";

import { setLevel } from "../lib/log";
import type { DitherDocument } from "../types/document";
import {
  AutosaveWriter,
  encodeAutosave,
  loadAutosave,
  type AutosaveStorage,
} from "./autosave";
import { createDocument } from "./document";
import { DocumentError } from "./errors";
import { testRegistry } from "./fixture";
import { addNode } from "./mutations";
import { restoreNotice } from "./store";

setLevel("error");

const registry = testRegistry();

/** An in-memory storage, so the scheduling can be exercised without a browser. */
class MemoryStorage implements AutosaveStorage {
  text: string | null = null;
  writes = 0;
  failNext = false;

  async read(): Promise<string | null> {
    return this.text;
  }

  async write(text: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("disk full");
    }
    this.text = text;
    this.writes += 1;
  }

  async clear(): Promise<void> {
    this.text = null;
  }
}

function sample(): DitherDocument {
  return addNode(createDocument(), registry, "test-levels").document;
}

describe("the record", () => {
  it("round-trips the document and the time it was saved", async () => {
    const storage = new MemoryStorage();
    const savedAt = new Date("2026-02-03T04:05:06.000Z");
    storage.text = encodeAutosave(sample(), savedAt);

    const restored = await loadAutosave(storage, registry);
    expect(restored?.document).toEqual(sample());
    expect(restored?.savedAt.toISOString()).toBe(savedAt.toISOString());
  });

  it("names the image the document was built on", async () => {
    const storage = new MemoryStorage();
    const document: DitherDocument = {
      ...sample(),
      source: { name: "photo.png", width: 10, height: 10 },
    };
    storage.text = encodeAutosave(document, new Date());

    const restored = await loadAutosave(storage, registry);
    expect(restored?.sourceName).toBe("photo.png");

    // The notice has to say the picture is not in the record, or a restored
    // document with no image under it looks like a failure to load one.
    const notice = restoreNotice(restored?.savedAt ?? new Date(), restored?.sourceName ?? null);
    expect(notice.message).toContain("photo.png");
    expect(notice.message).toMatch(/recipe and not the picture/);
  });

  it("returns null when there is nothing stored", async () => {
    expect(await loadAutosave(new MemoryStorage(), registry)).toBeNull();
  });

  it("refuses a record it cannot read rather than restoring something else", async () => {
    const storage = new MemoryStorage();
    storage.text = "{not json";
    await expect(loadAutosave(storage, registry)).rejects.toBeInstanceOf(DocumentError);

    storage.text = JSON.stringify({ savedAt: "yesterday", document: sample() });
    await expect(loadAutosave(storage, registry)).rejects.toThrow(/timestamp/);
  });
});

describe("the writer", () => {
  it("writes once after the edits stop", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const writer = new AutosaveWriter(storage, 1_000);

      writer.schedule(sample());
      writer.schedule(sample());
      writer.schedule(sample());
      expect(storage.writes).toBe(0);

      await vi.advanceTimersByTimeAsync(1_000);
      // Three edits, one write: a slider drag must not be one file write per
      // pointer move.
      expect(storage.writes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes on demand, for the page going away", async () => {
    const storage = new MemoryStorage();
    const writer = new AutosaveWriter(storage, 60_000);
    writer.schedule(sample());
    await writer.flush();
    expect(storage.writes).toBe(1);
    expect(storage.text).not.toBeNull();
  });

  it("survives a failed write and tries again on the next edit", async () => {
    // A full disk is not a reason to lose the document on screen.
    const storage = new MemoryStorage();
    const writer = new AutosaveWriter(storage, 0);
    storage.failNext = true;

    writer.schedule(sample());
    await writer.flush();
    expect(storage.writes).toBe(0);

    writer.schedule(sample());
    await writer.flush();
    expect(storage.writes).toBe(1);
  });

  it("drops nothing that has already been flushed", async () => {
    const storage = new MemoryStorage();
    const writer = new AutosaveWriter(storage, 60_000);
    writer.schedule(sample());
    await writer.flush();
    await writer.flush();
    expect(storage.writes).toBe(1);
    writer.dispose();
  });
});
