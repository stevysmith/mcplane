/**
 * Image facts the stores check, read from the bytes rather than the name or content type:
 * the format, and pixel (or SVG viewBox) dimensions. Enough of PNG, JPEG, WebP and SVG to say
 * whether an icon is square and big enough. No dependencies, so it runs anywhere.
 */
export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'svg';

export interface ImageInfo {
  format: ImageFormat | null;
  width?: number;
  height?: number;
  /** Why the dimensions couldn't be read. */
  error?: string;
}

export const EXTENSION: Record<ImageFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', svg: 'svg' };

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

export function sniff(b: Uint8Array): ImageFormat | null {
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  const head = new TextDecoder().decode(b.subarray(0, 8192)).replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

function png(b: Uint8Array, v: DataView) {
  if (b.length < 24 || ascii(b, 12, 16) !== 'IHDR') throw new Error('PNG has no IHDR chunk');
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

function jpeg(b: Uint8Array, v: DataView) {
  let p = 2;
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) throw new Error('JPEG segment marker missing');
    const marker = b[p + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    // Start-of-frame markers carry the size; C4, C8 and CC are other segments in the same range.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: v.getUint16(p + 5), width: v.getUint16(p + 7) };
    p += 2 + v.getUint16(p + 2);
  }
  throw new Error('JPEG has no frame header');
}

function webp(b: Uint8Array, v: DataView) {
  const chunk = ascii(b, 12, 16);
  const u24 = (at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
  if (chunk === 'VP8 ' && b.length >= 30) return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = v.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) return { width: u24(24) + 1, height: u24(27) + 1 };
  throw new Error(`unknown WebP chunk "${chunk}"`);
}

function svg(src: string) {
  const root = /<svg\b([^>]*)>/i.exec(src.replace(/<!--[\s\S]*?-->/g, ''));
  if (!root) throw new Error('no <svg> element');
  const attr = (n: string) => new RegExp(`\\s${n}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root[1])?.[1];
  const vb = attr('viewBox');
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) throw new Error(`viewBox "${vb}" isn't four numbers`);
    return { width: parts[2], height: parts[3] };
  }
  const [w, h] = [attr('width'), attr('height')];
  if (!w || !h) throw new Error('the SVG has neither a viewBox nor a width and height');
  if (!/^\d+(\.\d+)?(px)?$/.test(w) || !/^\d+(\.\d+)?(px)?$/.test(h)) throw new Error(`width "${w}" and height "${h}" aren't plain numbers`);
  return { width: parseFloat(w), height: parseFloat(h) };
}

export function imageInfo(bytes: Uint8Array): ImageInfo {
  const format = sniff(bytes);
  if (!format) return { format, error: 'not a PNG, JPEG, WebP or SVG file' };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (format === 'png') return { format, ...png(bytes, v) };
    if (format === 'jpeg') return { format, ...jpeg(bytes, v) };
    if (format === 'webp') return { format, ...webp(bytes, v) };
    return { format, ...svg(new TextDecoder().decode(bytes)) };
  } catch (e) {
    return { format, error: (e as Error).message };
  }
}

/** What's wrong with an image as a store icon: square, and 48 to 4096 px for raster formats. Empty when it's fine. */
export function iconProblems(info: ImageInfo, label: string, opts: { min?: number; max?: number } = {}): string[] {
  const min = opts.min ?? 48;
  const max = opts.max ?? 4096;
  if (!info.format || info.error || info.width === undefined || info.height === undefined) return [`${label} ${info.error ?? "can't be read"}`];
  const out: string[] = [];
  if (info.width !== info.height) out.push(`${label} is ${info.width}×${info.height}; it must be square`);
  else if (info.format !== 'svg' && (info.width < min || info.width > max)) out.push(`${label} is ${info.width} px; it must be ${min} to ${max} px`);
  else if (info.format === 'svg' && info.width < min) out.push(`${label}'s viewBox is ${info.width} units; make it at least ${min}`);
  return out;
}
