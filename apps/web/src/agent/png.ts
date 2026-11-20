/**
 * Just enough PNG for the per-game share card (share-card.ts): write an 8-bit indexed image, and
 * swap the palette of one without touching its pixels. Recolouring a board this way costs a few
 * hundred bytes of work at the edge, with no image library, no rasteriser and no decoding.
 *
 * Self-contained (no imports), so the build script that draws the card can load it directly.
 */

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

let table: Uint32Array | null = null;

/** CRC-32 as PNG uses it (ISO 3309, polynomial 0xEDB88320). */
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = table[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface Chunk {
  type: string;
  data: Uint8Array;
}

/** The chunks of a PNG, in order. Throws on anything that is not one. */
export function readChunks(png: Uint8Array): Chunk[] {
  if (png.length < 8 || SIGNATURE.some((b, i) => png[i] !== b)) throw new Error("not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Chunk[] = [];
  let at = 8;
  while (at + 12 <= png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (at + 12 + length > png.length) throw new Error("truncated PNG");
    chunks.push({ type, data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

/** A PNG made of these chunks, each with its length and CRC. */
export function writeChunks(chunks: readonly Chunk[]): Uint8Array {
  const size = 8 + chunks.reduce((n, c) => n + 12 + c.data.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = 8;
  for (const c of chunks) {
    view.setUint32(at, c.data.length);
    const typed = new Uint8Array(4 + c.data.length);
    for (let i = 0; i < 4; i++) typed[i] = c.type.charCodeAt(i);
    typed.set(c.data, 4);
    out.set(typed, at + 4);
    view.setUint32(at + 8 + c.data.length, crc32(typed));
    at += 12 + c.data.length;
  }
  return out;
}

export type Rgb = readonly [number, number, number];

/** Palette entries as a PLTE chunk's bytes. */
export function paletteBytes(palette: readonly Rgb[]): Uint8Array {
  if (palette.length === 0 || palette.length > 256) throw new Error("a palette has 1 to 256 entries");
  const out = new Uint8Array(palette.length * 3);
  palette.forEach(([r, g, b], i) => out.set([r & 255, g & 255, b & 255], i * 3));
  return out;
}

/** The palette of an indexed PNG. */
export function readPalette(png: Uint8Array): Rgb[] {
  const plte = readChunks(png).find((c) => c.type === "PLTE");
  if (!plte) throw new Error("no palette");
  const out: Rgb[] = [];
  for (let i = 0; i + 2 < plte.data.length; i += 3) out.push([plte.data[i]!, plte.data[i + 1]!, plte.data[i + 2]!]);
  return out;
}

/**
 * The same indexed image with another palette: every other chunk, the pixels included, is copied
 * byte for byte. The new palette must be exactly as long as the old one.
 */
export function withPalette(png: Uint8Array, palette: readonly Rgb[]): Uint8Array {
  const chunks = readChunks(png);
  const i = chunks.findIndex((c) => c.type === "PLTE");
  if (i < 0) throw new Error("no palette");
  if (chunks[i]!.data.length !== palette.length * 3) throw new Error("the palette must keep its length");
  return writeChunks(chunks.map((c, j) => (j === i ? { type: "PLTE", data: paletteBytes(palette) } : c)));
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An 8-bit indexed PNG: `indices` holds one palette index per pixel, row by row. */
export async function encodeIndexed(width: number, height: number, indices: Uint8Array, palette: readonly Rgb[]): Promise<Uint8Array> {
  if (indices.length !== width * height) throw new Error("one index per pixel");
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, 3, 0, 0, 0], 8); // 8 bits, indexed colour, deflate, adaptive filtering, no interlace
  // Each row starts with filter type 0 (none): indexed images compress best unfiltered.
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  return writeChunks([
    { type: "IHDR", data: header },
    { type: "PLTE", data: paletteBytes(palette) },
    { type: "IDAT", data: await deflate(raw) },
    { type: "IEND", data: new Uint8Array(0) },
  ]);
}
