/**
 * The one thing every export in the application shares: the write.
 *
 * Still export, animated export and batch all end at `writeToDestination`, so
 * it is the only place that can promise a zero-length file never reaches a
 * disk. These tests are about that promise and about the *order* it is kept in
 * — the File System Access path truncates the file the person picked as soon as
 * `createWritable()` is called, so a refusal that came after it would already
 * have destroyed whatever was there.
 *
 * The environment is Node with no DOM (see `vitest.config.ts`), which the
 * download cases lean on rather than work around: `document` does not exist
 * here, so a refusal that reached the anchor would fail with a `ReferenceError`
 * instead of the refusal being asserted.
 */

import { describe, expect, it } from "vitest";

import { EmptyExportError, writeToDestination, type Destination } from "./destination";

/**
 * A file handle that records, and shouts if it is opened at all.
 *
 * Not a stand-in for anything under test: `FileSystemFileHandle` is a platform
 * object with no Node implementation, and the thing being asserted is whether
 * this application calls it, which is exactly what a recorder can answer.
 */
function recordingHandle(name: string): {
  readonly handle: FileSystemFileHandle;
  readonly opened: () => number;
  readonly written: () => readonly Blob[];
  readonly closed: () => number;
} {
  let opened = 0;
  let closed = 0;
  const written: Blob[] = [];

  const writable = {
    async write(blob: Blob): Promise<void> {
      written.push(blob);
    },
    async close(): Promise<void> {
      closed += 1;
    },
    async abort(): Promise<void> {},
  };

  const handle = {
    name,
    kind: "file" as const,
    async createWritable(): Promise<unknown> {
      opened += 1;
      return writable;
    },
  };

  return {
    handle: handle as unknown as FileSystemFileHandle,
    opened: () => opened,
    written: () => written,
    closed: () => closed,
  };
}

describe("an export that produced no bytes", () => {
  it("is refused rather than downloaded, and names the file it did not write", async () => {
    const destination: Destination = { kind: "download", name: "loop-dither-48f.gif" };

    await expect(writeToDestination(destination, new Blob([]))).rejects.toThrow(
      EmptyExportError,
    );
    await expect(writeToDestination(destination, new Blob([]))).rejects.toThrow(
      /loop-dither-48f\.gif/,
    );
  });

  it("is refused before the picked file is opened, so nothing is truncated", async () => {
    const target = recordingHandle("loop-dither-48f.gif");

    await expect(
      writeToDestination({ kind: "file-system-access", handle: target.handle }, new Blob([])),
    ).rejects.toThrow(EmptyExportError);

    // The whole point of checking first: `createWritable()` empties the file on
    // the way in, so an export refused after it would have replaced last week's
    // good GIF with this week's empty one.
    expect(target.opened()).toBe(0);
    expect(target.written()).toEqual([]);
  });

  it("says what happened, in the words a person needs", async () => {
    const error = await writeToDestination(
      { kind: "download", name: "loop.gif" },
      new Blob([]),
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("produced no bytes");
    expect((error as Error).message).toContain("was not written");
  });
});

describe("an export that produced bytes", () => {
  it("is written, and the writable is closed", async () => {
    const target = recordingHandle("loop.gif");
    const blob = new Blob([new Uint8Array([0x47, 0x49, 0x46])], { type: "image/gif" });

    await writeToDestination({ kind: "file-system-access", handle: target.handle }, blob);

    expect(target.opened()).toBe(1);
    expect(target.written()).toEqual([blob]);
    expect(target.closed()).toBe(1);
  });
});
