import { utf8Bytes } from "../cache/utf8.js";

/**
 * A minimal ZIP writer.
 *
 * EPUB and DOCX are both zip archives of XML, so one writer serves both. The
 * alternative — shelling out to pandoc on the worker — puts an external binary
 * in the deployment, makes export a network round trip, and cannot run at all on
 * the device. This is a few hundred lines and removes all three problems: a
 * finished book can be exported with the network off, which is the same promise
 * the rest of the app makes about the writing it came from.
 *
 * Deliberately narrow. No ZIP64, no encryption, no data descriptors: entries are
 * built in memory, so sizes and CRCs are known before the header is written.
 * A book is a few hundred kilobytes of XHTML — the 4GB ceiling is not a
 * constraint we will ever meet.
 */

export interface ZipEntry {
  /** Path inside the archive, forward slashes, no leading slash. */
  readonly name: string;
  readonly data: Uint8Array;
  /**
   * Force this entry to be stored uncompressed.
   *
   * EPUB requires it of exactly one file: `mimetype` must be the first entry and
   * stored, so that a reader can identify the format by byte offset without
   * inflating anything.
   */
  readonly store?: boolean;
}

/**
 * Optional DEFLATE. Core stays platform-free, so compression is injected:
 * `node:zlib` on the worker, nothing on the phone.
 *
 * Returning `null` means "not worth it" — the writer falls back to storing,
 * which every unzipper handles.
 */
export type Deflater = (data: Uint8Array) => Uint8Array | null;

export interface ZipOptions {
  readonly deflate?: Deflater;
  /**
   * Timestamp written into every entry. Fixed by default so that exporting the
   * same book twice produces byte-identical files — which is what makes an
   * export diffable and a test able to assert on it.
   */
  readonly modifiedAt?: Date;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

const STORED = 0;
const DEFLATED = 8;

/** Bit 11 of the general-purpose flags: the name is UTF-8 rather than CP437. */
const UTF8_NAME_FLAG = 0x0800;

/** 2020-01-01T00:00:00Z. Any fixed date does; this one is unambiguous in DOS format. */
const DEFAULT_MTIME = new Date(Date.UTC(2020, 0, 1));

export function zip(entries: readonly ZipEntry[], opts: ZipOptions = {}): Uint8Array {
  const { time, date } = dosTimestamp(opts.modifiedAt ?? DEFAULT_MTIME);

  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = utf8Bytes(entry.name);
    const crc = crc32(entry.data);

    const compressed =
      entry.store === true || opts.deflate === undefined
        ? null
        : shrink(opts.deflate, entry.data);

    const method = compressed === null ? STORED : DEFLATED;
    const payload = compressed ?? entry.data;
    const flags = isAscii(entry.name) ? 0 : UTF8_NAME_FLAG;

    const header = new Uint8Array(30 + name.length);
    const h = new DataView(header.buffer);
    h.setUint32(0, LOCAL_SIGNATURE, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, flags, true);
    h.setUint16(8, method, true);
    h.setUint16(10, time, true);
    h.setUint16(12, date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, payload.length, true);
    h.setUint32(22, entry.data.length, true);
    h.setUint16(26, name.length, true);
    h.setUint16(28, 0, true);
    header.set(name, 30);

    const record = new Uint8Array(46 + name.length);
    const r = new DataView(record.buffer);
    r.setUint32(0, CENTRAL_SIGNATURE, true);
    r.setUint16(4, 20, true);
    r.setUint16(6, 20, true);
    r.setUint16(8, flags, true);
    r.setUint16(10, method, true);
    r.setUint16(12, time, true);
    r.setUint16(14, date, true);
    r.setUint32(16, crc, true);
    r.setUint32(20, payload.length, true);
    r.setUint32(24, entry.data.length, true);
    r.setUint16(28, name.length, true);
    r.setUint16(30, 0, true);
    r.setUint16(32, 0, true);
    r.setUint16(34, 0, true);
    r.setUint16(36, 0, true);
    // 0o100644 in the high word: a regular, world-readable file. Unzippers that
    // honour Unix modes otherwise produce files with no permission bits at all.
    r.setUint32(38, 0o100644 << 16, true);
    r.setUint32(42, offset, true);
    record.set(name, 46);

    local.push(header, payload);
    central.push(record);
    offset += header.length + payload.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);

  const eocd = new Uint8Array(22);
  const e = new DataView(eocd.buffer);
  e.setUint32(0, EOCD_SIGNATURE, true);
  e.setUint16(4, 0, true);
  e.setUint16(6, 0, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  e.setUint16(20, 0, true);

  return concat([...local, ...central, eocd]);
}

/**
 * Compresses, unless compressing made it bigger.
 *
 * DEFLATE on already-compressed or very short data can grow it. Storing in that
 * case is both smaller and faster to read back.
 */
function shrink(deflate: Deflater, data: Uint8Array): Uint8Array | null {
  const out = deflate(data);
  if (out === null) return null;
  return out.length < data.length ? out : null;
}

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** MS-DOS date and time, which is what the ZIP format stores. Two-second resolution. */
function dosTimestamp(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getUTCFullYear());
  return {
    time:
      (when.getUTCHours() << 11) |
      (when.getUTCMinutes() << 5) |
      (Math.floor(when.getUTCSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate(),
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
