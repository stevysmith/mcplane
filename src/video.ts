/**
 * Recorded scenes to one mp4 with ffmpeg: a title card, then each scene at real
 * speed with its caption burned in. A DevTools screencast only sends a frame when
 * something on screen changes, so each frame is held until the next one arrives
 * (ffmpeg's concat demuxer with a duration per frame).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

/** One screencast frame: a JPEG relative to the work folder, and when it was shown (seconds). */
export interface Frame {
  file: string;
  ts: number;
}

export interface Scene {
  caption: string;
  frames: Frame[];
  /** When recording stopped; the last frame is held until then. */
  end: number;
}

const FPS = 30;
const DARK = '0x16181d';
const TITLE_SECONDS = 3;
const FONTS = ['/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial Unicode.ttf'];

/** ffmpeg's concat-demuxer list: each frame held until the next one, the last until `end`. */
export function concatList(frames: Frame[], end: number): string {
  if (!frames.length) throw new Error('No frames were recorded for this scene.');
  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  const entry = (f: Frame) => `file '${f.file.replace(/'/g, "'\\''")}'`;
  const lines: string[] = [];
  sorted.forEach((f, i) => {
    const until = i + 1 < sorted.length ? sorted[i + 1].ts : Math.max(end, f.ts + 1 / FPS);
    lines.push(entry(f), `duration ${Math.max(0.001, until - f.ts).toFixed(3)}`);
  });
  // The demuxer ignores the last entry's duration, so the last frame is listed once more.
  lines.push(entry(sorted[sorted.length - 1]));
  return `${lines.join('\n')}\n`;
}

/** How long a scene runs once assembled. */
export function sceneSeconds(s: Scene): number {
  if (!s.frames.length) return 0;
  return Math.max(s.end, Math.max(...s.frames.map((f) => f.ts))) - Math.min(...s.frames.map((f) => f.ts));
}

/**
 * Escapes a value for a filter option inside an ffmpeg filtergraph. Two levels:
 * the option value (\ ' :) and then the filtergraph itself (\ ' [ ] , ;).
 */
export function ffEscape(value: string): string {
  const option = value.replace(/[\\':]/g, (c) => `\\${c}`);
  return option.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

/**
 * A caption as at most `maxLines` lines of about `width` characters. Control
 * characters become spaces (drawtext would draw them as boxes); anything that
 * doesn't fit ends in an ellipsis.
 */
export function wrapCaption(text: string, width = 64, maxLines = 2): string[] {
  const words = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && `${last} ${w}`.length <= width) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let tail = kept[maxLines - 1];
  while (tail.length > width - 1 && tail.includes(' ')) tail = tail.slice(0, tail.lastIndexOf(' '));
  kept[maxLines - 1] = `${tail.replace(/[\s,;:.]+$/, '')}…`;
  return kept;
}

/** Width and height from a JPEG's start-of-frame marker. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

/** Even dimensions (H.264 needs them) within the maximum, keeping the aspect ratio. */
export function outputSize(width: number, height: number, maxWidth = 1920, maxHeight = 1200): { width: number; height: number } {
  const s = Math.min(1, maxWidth / width, maxHeight / height);
  const even = (n: number) => Math.max(2, Math.floor((n * s) / 2) * 2);
  return { width: even(width), height: even(height) };
}

export function findFfmpeg(path = process.env.PATH ?? ''): string | null {
  for (const dir of [...path.split(delimiter), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (dir && existsSync(join(dir, 'ffmpeg'))) return join(dir, 'ffmpeg');
  }
  return null;
}

/** A drawtext filter reading its text from a file, so no caption needs filtergraph escaping. */
function drawtext(o: { textfile: string; font: string; size: number; y: string; color: string }): string {
  return [`drawtext=fontfile=${ffEscape(o.font)}`, `textfile=${ffEscape(o.textfile)}`, 'expansion=none', `fontsize=${o.size}`, `fontcolor=${o.color}`, 'x=(w-tw)/2', `y=${o.y}`].join(':');
}

/** Text colours that read on a background, given as 0xRRGGBB: light on dark, dark on light. */
export function inkFor(bg: string): { text: string; muted: string } {
  const n = parseInt(bg.replace(/^(0x|#)/, ''), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
  return light ? { text: '0x1d1d1f', muted: '0x5f6673' } : { text: 'white', muted: '0x9aa3b2' };
}

/** The app's background colour, from a frame's bottom-left corner, so the borders and caption band blend in. */
function sampleBackground(ffmpeg: string, file: string, cwd: string): Promise<string | null> {
  return new Promise((done) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-i', file, '-vf', 'format=rgb24,crop=1:1:4:ih-5', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.on('error', () => done(null));
    p.on('close', (code) => {
      const px = Buffer.concat(chunks);
      done(code === 0 && px.length >= 3 ? `0x${[px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}` : null);
    });
  });
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((done, fail) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg failed: ${err.trim().split('\n').slice(-3).join(' ')}`))));
  });
}

/**
 * Builds the video in `work` (where the frames are) and writes it to `out`.
 * Every part is encoded the same way so they join without re-encoding.
 */
export async function buildVideo(o: { scenes: Scene[]; title: string; subtitle?: string; out: string; work: string; ffmpeg: string; size: { width: number; height: number } }): Promise<number> {
  const { width: W, height: H } = o.size;
  const k = H / 1200;
  const font = FONTS.find((f) => existsSync(f));
  if (!font) throw new Error(`No font for captions; looked for ${FONTS.join(', ')}`);
  const enc = ['-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-video_track_timescale', '15360'];
  const parts: string[] = [];
  const first = o.scenes.find((s) => s.frames.length)?.frames[0];
  const bg = (first && (await sampleBackground(o.ffmpeg, first.file, o.work))) ?? DARK;
  const ink = inkFor(bg);

  // Title card: the name large, one line of what it does underneath.
  await writeFile(join(o.work, 'title.txt'), o.title);
  const sub = o.subtitle ? wrapCaption(o.subtitle, 70) : [];
  for (const [i, line] of sub.entries()) await writeFile(join(o.work, `title-${i}.txt`), line);
  const titleSize = Math.round(76 * k);
  const subSize = Math.round(38 * k);
  const titleY = sub.length ? `(h/2)-th-${Math.round(24 * k)}` : '(h-th)/2';
  const titleFilters = [
    drawtext({ textfile: 'title.txt', font, size: titleSize, color: ink.text, y: titleY }),
    ...sub.map((_, i) => drawtext({ textfile: `title-${i}.txt`, font, size: subSize, color: ink.muted, y: `(h/2)+${Math.round((24 + i * 54) * k)}` })),
    'format=yuv420p',
  ];
  await run(o.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${bg}:s=${W}x${H}:r=${FPS}:d=${TITLE_SECONDS}`, '-vf', titleFilters.join(','), ...enc, 'part-title.mp4'], o.work);
  parts.push('part-title.mp4');

  // Scenes: the window at real speed above a band that holds the caption, so it never covers the app.
  const band = Math.round((136 * k) / 2) * 2;
  const capSize = Math.round(38 * k);
  const lineH = Math.round(50 * k);
  for (const [i, s] of o.scenes.entries()) {
    await writeFile(join(o.work, `scene-${i}.txt`), concatList(s.frames, s.end));
    const lines = wrapCaption(s.caption, 80);
    const filters = [`scale=${W}:${H - band}:force_original_aspect_ratio=decrease:flags=lanczos`, `pad=${W}:${H}:(ow-iw)/2:0:color=${bg}`, `fps=${FPS}`];
    const top = H - band + Math.round((band - lines.length * lineH) / 2);
    for (const [j, line] of lines.entries()) {
      await writeFile(join(o.work, `caption-${i}-${j}.txt`), line);
      filters.push(drawtext({ textfile: `caption-${i}-${j}.txt`, font, size: capSize, color: ink.text, y: `${top + j * lineH}+(${lineH}-th)/2` }));
    }
    filters.push('format=yuv420p');
    await run(o.ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', `scene-${i}.txt`, '-vf', filters.join(','), ...enc, `part-${i}.mp4`], o.work);
    parts.push(`part-${i}.mp4`);
  }

  await writeFile(join(o.work, 'parts.txt'), parts.map((p) => `file '${p}'`).join('\n') + '\n');
  await run(o.ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', 'parts.txt', '-c', 'copy', '-movflags', '+faststart', resolve(o.out)], o.work);
  return TITLE_SECONDS + o.scenes.reduce((n, s) => n + sceneSeconds(s), 0);
}
