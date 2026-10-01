/**
 * A minimal ZIP writer (deflate, no dependencies): enough to build the plugin
 * package ChatGPT's submission portal takes, and a reader to check it.
 *
 * Every entry is dated 1980-01-01 00:00, the first valid DOS date (an all-zero
 * date has month 0, which some readers reject), so the same files always give
 * the same bytes. Entries carry Unix modes, so a script marked executable stays
 * executable when the package is unpacked.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 1980-01-01 00:00 in DOS format: (year - 1980) << 9 | month << 5 | day. */
export const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const UTF8 = 0x0800;
/** "Version made by": Unix (3), ZIP 2.0, so readers apply the modes in the external attributes. */
const MADE_BY_UNIX = (3 << 8) | 20;
const REGULAR_FILE = 0o100000;

export interface ZipEntry {
  path: string;
  data: Uint8Array | string;
  /** Unix permission bits; 0o644 unless given. Use 0o755 for scripts. */
  mode?: number;
}

export function zip(files: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const body = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, UTF8, true);
    lv.setUint16(8, 8, true); // deflate
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, MADE_BY_UNIX, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, UTF8, true);
    cv.setUint16(10, 8, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, ((REGULAR_FILE | ((f.mode ?? 0o644) & 0o777)) << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    locals.push(local, body);
    central.push(cen);
    offset += local.length + body.length;
  }
  const cenSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cenSize + 22);
  let p = 0;
  for (const part of [...locals, ...central, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

export interface UnzippedEntry {
  path: string;
  data: Uint8Array;
  /** Unix permission bits, when the archive was made on Unix. */
  mode: number | null;
  dosDate: number;
}

/** Reads every entry from the central directory, inflating and checking each CRC. */
export function unzip(buf: Uint8Array): UnzippedEntry[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP: no end of central directory');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: UnzippedEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error(`bad central directory entry ${i}`);
    const madeBy = v.getUint16(p + 4, true);
    const method = v.getUint16(p + 10, true);
    const dosDate = v.getUint16(p + 14, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const attrs = v.getUint32(p + 38, true);
    const at = v.getUint32(p + 42, true);
    const path = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    const start = at + 30 + v.getUint16(at + 26, true) + v.getUint16(at + 28, true);
    const body = buf.subarray(start, start + csize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(body)) : method === 0 ? body.slice() : null;
    if (!data) throw new Error(`${path}: unsupported compression method ${method}`);
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`${path}: CRC or size mismatch`);
    out.push({ path, data, mode: madeBy >> 8 === 3 ? (attrs >>> 16) & 0o777 : null, dosDate });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
