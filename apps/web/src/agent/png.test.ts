import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, encodeIndexed, readChunks, readPalette, withPalette } from "./png.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("png", () => {
  it("computes the CRC PNG uses", () => {
    // Every PNG ends with this chunk, whose CRC is fixed.
    expect(crc32(bytes("IEND"))).toBe(0xae426082);
    expect(crc32(bytes("123456789"))).toBe(0xcbf43926);
  });

  it("writes an indexed image whose pixels and palette read back", async () => {
    const indices = new Uint8Array([0, 1, 2, 1, 0, 2]);
    const png = await encodeIndexed(3, 2, indices, [
      [0, 0, 0],
      [255, 0, 0],
      [0, 0, 255],
    ]);
    const chunks = readChunks(png);
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "PLTE", "IDAT", "IEND"]);
    const header = chunks[0]!.data;
    expect([...header.subarray(8, 13)]).toEqual([8, 3, 0, 0, 0]);
    // Each row is a filter byte (none) and then its indices.
    expect([...inflateSync(chunks[2]!.data)]).toEqual([0, 0, 1, 2, 0, 1, 0, 2]);
    expect(readPalette(png)).toEqual([
      [0, 0, 0],
      [255, 0, 0],
      [0, 0, 255],
    ]);
  });

  it("swaps the palette and copies every other chunk byte for byte", async () => {
    const png = await encodeIndexed(2, 1, new Uint8Array([0, 1]), [
      [1, 2, 3],
      [4, 5, 6],
    ]);
    const swapped = withPalette(png, [
      [9, 9, 9],
      [4, 5, 6],
    ]);
    expect(readPalette(swapped)).toEqual([
      [9, 9, 9],
      [4, 5, 6],
    ]);
    const [a, b] = [readChunks(png), readChunks(swapped)];
    expect(b[2]!.data).toEqual(a[2]!.data);
    expect(swapped.length).toBe(png.length);
    // The CRCs are rewritten: a decoder checks them.
    const view = new DataView(swapped.buffer);
    const plteAt = 8 + 12 + 13;
    expect(view.getUint32(plteAt + 8 + 6)).toBe(crc32(swapped.subarray(plteAt + 4, plteAt + 8 + 6)));
  });

  it("refuses what is not a PNG, and a palette of another length", async () => {
    expect(() => readChunks(bytes("GIF89a"))).toThrow(/not a PNG/);
    const png = await encodeIndexed(1, 1, new Uint8Array([0]), [[0, 0, 0]]);
    expect(() => withPalette(png, [])).toThrow();
    expect(() => withPalette(png, [
      [0, 0, 0],
      [1, 1, 1],
    ])).toThrow(/length/);
  });
});
