/**
 * REN-06: a bounded window over a file, with the Buffer-shaped reads the media probe needs.
 *
 * WHY THIS EXISTS
 * ---------------
 * `probeVideo` read the ENTIRE file to look for the `moov` atom:
 *
 *     return probeIsoBmffVideo(fs.readFileSync(filePath));
 *
 * For a 200 MB upload that is a 200 MB Buffer, and it showed up exactly as such in the acceptance run:
 * peak `external` memory on the server measured 221.7 MiB against a 217 MiB file, which is a whole-file
 * buffer by any definition. The upload path itself was streaming correctly (the client sent 217 MiB using
 * 8.5 MiB of extra RSS); the buffer appeared one step later, when the uploaded file was probed for its
 * metadata. Fixing only the upload transport would have left the peak in place, so the probe is fixed too.
 *
 * HOW
 * ---
 * The atom walker needs a handful of small reads at arbitrary offsets (box sizes, types, track headers). It
 * does not need the file. This class exposes the same read methods the walker already uses, backed by
 * cached fixed-size blocks of the file, so the walker's logic is unchanged and memory is bounded by the
 * cache rather than by the file.
 *
 * Memory bound: `blockBytes * maxBlocks` (64 KiB * 8 = 512 KiB by default), plus whatever single span a
 * caller explicitly asks for - and `readBytes` refuses spans beyond `maxSpanBytes` so no caller can
 * accidentally reintroduce a whole-file read.
 */
import fs from "node:fs";

export class FileWindow {
  constructor(filePath, { blockBytes = 64 * 1024, maxBlocks = 8, maxSpanBytes = 1 * 1024 * 1024 } = {}) {
    this.handle = fs.openSync(filePath, "r");
    this.length = fs.fstatSync(this.handle).size;
    this.blockBytes = blockBytes;
    this.maxBlocks = maxBlocks;
    this.maxSpanBytes = maxSpanBytes;
    this.cache = new Map(); // blockIndex -> Buffer
    this.reads = 0;
    this.cacheHits = 0;
  }

  close() {
    if (this.handle !== undefined && this.handle !== null) {
      fs.closeSync(this.handle);
      this.handle = null;
    }
  }

  /** One cached block. Blocks are small, and the walker revisits the same offsets heavily. */
  #block(index) {
    const cached = this.cache.get(index);
    if (cached) {
      this.cacheHits += 1;
      return cached;
    }
    const start = index * this.blockBytes;
    const length = Math.max(0, Math.min(this.blockBytes, this.length - start));
    const buffer = Buffer.allocUnsafe(length);
    if (length > 0) {
      const read = fs.readSync(this.handle, buffer, 0, length, start);
      this.reads += 1;
      if (read < length) return buffer.subarray(0, read);
    }
    // Simple bounded cache: evict the oldest entry once the cap is reached.
    if (this.cache.size >= this.maxBlocks) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(index, buffer);
    return buffer;
  }

  /** Read `length` bytes at `offset` across block boundaries, bounded by maxSpanBytes. */
  readBytes(offset, length) {
    if (length > this.maxSpanBytes) {
      throw new Error(`FileWindow.readBytes refuses a ${length}-byte span; the cap is ${this.maxSpanBytes} bytes so a whole-file read can not creep back in`);
    }
    const out = Buffer.allocUnsafe(length);
    let copied = 0;
    while (copied < length) {
      const absolute = offset + copied;
      const block = this.#block(Math.floor(absolute / this.blockBytes));
      const within = absolute % this.blockBytes;
      const available = Math.min(length - copied, block.length - within);
      if (available <= 0) break;
      block.copy(out, copied, within, within + available);
      copied += available;
    }
    return out.subarray(0, copied);
  }

  /** True when the whole span is available (used by callers that must not read past EOF). */
  has(offset, length) {
    return offset >= 0 && length >= 0 && offset + length <= this.length;
  }

  readUInt32BE(offset) {
    return this.readBytes(offset, 4).readUInt32BE(0);
  }

  readUInt16BE(offset) {
    return this.readBytes(offset, 2).readUInt16BE(0);
  }

  readUInt32LE(offset) {
    return this.readBytes(offset, 4).readUInt32LE(0);
  }

  readUInt16LE(offset) {
    return this.readBytes(offset, 2).readUInt16LE(0);
  }

  readUIntLE(offset, byteLength) {
    return this.readBytes(offset, byteLength).readUIntLE(0, byteLength);
  }

  readBigUInt64BE(offset) {
    return this.readBytes(offset, 8).readBigUInt64BE(0);
  }

  toString(encoding, start, end) {
    if (encoding === "hex") return this.readBytes(start, end - start).toString("hex");
    if (encoding === "utf8") return this.readBytes(start, Math.min(end - start, this.maxSpanBytes)).toString("utf8");
    return this.readBytes(start, end - start).toString(encoding);
  }

  /** A bounded slice, for the rare callers that want a Buffer rather than a number. */
  subarray(start, end) {
    const length = Math.min(Math.max(0, end - start), this.maxSpanBytes);
    return this.readBytes(start, length);
  }

  at(index) {
    return this.#block(Math.floor(index / this.blockBytes))[index % this.blockBytes];
  }
}
