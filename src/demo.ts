/**
 * `mcplane demo`: fastlane's snapshot, for the agent era.
 *
 * ChatGPT's review asks for a demo video recorded in developer mode that shows
 * the main use cases and tools. This records it from the review tests in
 * mcplane.json: it drives the ChatGPT desktop app (macOS) over the Chrome
 * DevTools Protocol, opens a new chat per test with your plugin @mentioned,
 * types the prompt, waits for the answer and records the window. Then ffmpeg
 * joins the scenes behind a title card, one caption per scene.
 *
 * It uses your ChatGPT account, so it asks first, hides the sidebar (your chats
 * and name) before it records, only records while a test runs, and approves tool
 * calls only with --approve ("Allow once", never "Always allow").
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Cdp, listTargets, pickMainWindow } from './cdp.js';
import { ensureLocalDir } from './manifest.js';
import { listTools } from './packs.js';
import { buildVideo, findFfmpeg, jpegSize, outputSize, type Frame, type Scene } from './video.js';
import type { Manifest, Tool } from './types.js';

const APP = '/Applications/ChatGPT.app';
const BINARY = `${APP}/Contents/MacOS/ChatGPT`;
const MAIN_WINDOW = 'app://-/index.html';
const PORT = 9333;
/** Keep frames coming when the window is covered or in the background. */
const KEEP_RENDERING = ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'];
const REPLY_TIMEOUT = 5 * 60_000;

/**
 * Every label mcplane relies on in ChatGPT desktop (checked against 26.903, 1 October 2026).
 * When a release renames something, this is the one place to fix.
 */
export const UI = {
  hideSidebar: 'Hide sidebar',
  showSidebar: 'Show sidebar',
  newChat: 'New chat',
  chatMode: 'Chat',
  workMode: 'Work',
  addMenu: 'Add files and more',
  send: ['Send', 'Send prompt', 'Send message'],
  stop: ['Stop', 'Stop generating', 'Stop streaming'],
  /** Buttons on a tool approval card. */
  approval: ['Allow once', 'Always allow', 'Deny', 'Allow'],
  /** What --approve clicks, first match wins. Never "Always allow": a demo shouldn't change your settings. */
  allow: ['Allow once', 'Allow'],
  /** The collapsed summary of tool calls ("Worked for 5s"), opened at the end of each scene. */
  activity: '^(Worked|Thought|Working) for ',
  signIn: ['Log in', 'Sign up', 'Sign in'],
  /** Part of the message box's accessible name: "Message ChatGPT", "Ask ChatGPT", "Work with ChatGPT". */
  composer: 'ChatGPT',
  /** The @mention pill keeps the plugin's id here; developer-mode plugins are "created-by-me". */
  mentionAttr: 'plugin-mention-path',
  devMode: 'created-by-me',
};

/** Helpers every page script starts with. Plain strings: these run inside ChatGPT, not Node. */
const PAGE = String.raw`
const vis = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
  const hit = document.elementFromPoint(x, y);
  return !!hit && (hit === el || el.contains(hit));
};
const label = (el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
const buttons = () => [...document.querySelectorAll('button, [role=button]')].filter(vis);
const button = (names) => buttons().find((b) => names.includes(label(b))) || null;
const center = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
const composer = () => {
  const eds = [...document.querySelectorAll('[contenteditable=true], textarea')].filter(vis);
  return eds.find((e) => (e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').includes(UI.composer)) || eds[eds.length - 1] || null;
};
`;

type Point = { x: number; y: number };

/** The ChatGPT desktop window, driven through DevTools. */
class Desktop {
  private frameNo = 0;
  private pluginPick: { index: number; path: string } | null = null;

  constructor(private cdp: Cdp, private signal: AbortSignal) {}

  page<T>(body: string): Promise<T> {
    return this.cdp.evaluate<T>(`(() => { const UI = ${JSON.stringify(UI)};\n${PAGE}\n${body}\n})()`);
  }

  private wait(ms: number) {
    return sleep(ms, undefined, { signal: this.signal });
  }

  /** Polls until `fn` returns something truthy. */
  private async until<T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
      await this.wait(250);
    }
  }

  private async mouse(type: string, p: Point) {
    await this.cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
  }

  /** A real click, then the pointer parks at the window's right edge so no hover state or tooltip stays on screen. */
  async clickAt(p: Point) {
    await this.mouse('mouseMoved', p);
    await this.mouse('mousePressed', p);
    await this.mouse('mouseReleased', p);
    const size = await this.page<{ w: number; h: number }>('return { w: innerWidth, h: innerHeight };');
    await this.mouse('mouseMoved', { x: size.w - 3, y: Math.round(size.h / 2) });
  }

  /** Clicks the first visible button with one of these labels; false when there is none. */
  async click(names: string[]): Promise<boolean> {
    const p = await this.page<Point | null>(`const b = button(${JSON.stringify(names)}); return b && center(b);`);
    if (!p) return false;
    await this.clickAt(p);
    return true;
  }

  /** On macOS, shortcuts like Cmd+A only edit when the command is named; see `commands`. */
  async key(key: string, code: string, keyCode: number, modifiers = 0, text?: string, commands?: string[]) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await this.cdp.send('Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text, unmodifiedText: text } : {}), ...(commands ? { commands } : {}) });
    await this.cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  /** Waits for the app to load and settle; fails clearly when it's signed out. */
  async ready() {
    const state = await this.until(
      () => this.page<'ready' | 'signed-out' | null>(`if (button(UI.signIn)) return 'signed-out'; return button([UI.hideSidebar, UI.showSidebar]) || composer() ? 'ready' : null;`),
      60_000,
      'ChatGPT to load',
    );
    if (state === 'signed-out') throw new Error('ChatGPT is signed out. Sign in, then run mcplane demo again.');
    // Controls keep arriving for a second or two after the window loads (the Chat/Work
    // switch, the plugin list), so wait until the set of buttons stops changing.
    const end = Date.now() + 15_000;
    let last = -1;
    let since = Date.now();
    while (Date.now() < end) {
      const n = await this.page<number>('return buttons().length;');
      if (n !== last) [last, since] = [n, Date.now()];
      else if (Date.now() - since >= 1_500) break;
      await this.wait(250);
    }
    await this.key('Escape', 'Escape', 27); // close anything left open (menus, what's-new cards)
  }

  sidebarOpen(): Promise<boolean> {
    return this.page<boolean>('return !!button([UI.hideSidebar]);');
  }

  async hideSidebar() {
    if (!(await this.click([UI.hideSidebar]))) return;
    await this.until(async () => !(await this.sidebarOpen()), 5_000, 'the sidebar to close');
  }

  async showSidebar() {
    if (await this.click([UI.showSidebar])) await this.wait(400);
  }

  /** An empty chat, sidebar closed. Uses a visible "New chat" control, or the sidebar's. */
  async newChat() {
    if (!(await this.click([UI.newChat]))) {
      if (!(await this.click([UI.showSidebar]))) throw new Error(`Couldn't find "${UI.newChat}" or "${UI.showSidebar}" in ChatGPT.`);
      await this.until(() => this.click([UI.newChat]), 5_000, `"${UI.newChat}" in the sidebar`);
    }
    await this.wait(300);
    await this.hideSidebar();
    await this.until(() => this.page<boolean>('const c = composer(); return !!c && !c.textContent.trim() && !button(UI.stop);'), 10_000, 'a new chat');
  }

  /** Switches the new-chat screen to Chat or Work. Returns the mode it was in, or null when there's no switch. */
  async setMode(mode: string): Promise<string | null> {
    const find = () =>
      this.page<{ current: string | null; target: Point | null } | null>(`
        const opts = buttons().filter((b) => [UI.chatMode, UI.workMode].includes(label(b)) && b.hasAttribute('aria-pressed'));
        if (!opts.length) return null;
        const cur = opts.find((b) => b.getAttribute('aria-pressed') === 'true');
        const want = opts.find((b) => label(b) === ${JSON.stringify(mode)});
        return { current: cur ? label(cur) : null, target: want && want.getAttribute('aria-pressed') !== 'true' ? center(want) : null };`);
    const r = await this.until(find, 3_000, 'the Chat/Work switch').catch(() => null);
    if (!r) return null;
    if (r.target) {
      await this.clickAt(r.target);
      await this.until(() => this.page<boolean>(`return buttons().some((b) => label(b) === ${JSON.stringify(mode)} && b.getAttribute('aria-pressed') === 'true');`), 5_000, `${mode} mode`);
      await this.wait(400);
    }
    return r.current;
  }

  async clearComposer() {
    await this.page('const c = composer(); if (c) c.focus(); return true;');
    await this.key('a', 'KeyA', 65, 4, undefined, ['selectAll']);
    await this.key('Backspace', 'Backspace', 8);
  }

  /** Opens the + menu and returns the labels of entries that match the plugin's name. */
  private async pluginEntries(name: string): Promise<string[]> {
    await this.page('window.__mcplaneBefore = new Set(document.querySelectorAll("button")); return true;');
    if (!(await this.click([UI.addMenu]))) throw new Error(`Couldn't find "${UI.addMenu}" (the + button) in ChatGPT.`);
    await this.wait(600);
    return this.page<string[]>(`
      const before = window.__mcplaneBefore || new Set();
      const want = ${JSON.stringify(name.toLowerCase())};
      const items = [...document.querySelectorAll('button')].filter((b) => !before.has(b));
      const parts = (b) => [...b.querySelectorAll('span, div')].map((s) => s.textContent.trim().toLowerCase());
      let hits = items.filter((b) => parts(b).includes(want));
      if (!hits.length) hits = items.filter((b) => label(b).toLowerCase().includes(want));
      window.__mcplaneHits = hits;
      return hits.map(label);`);
  }

  private async pickEntry(i: number): Promise<string> {
    await this.page(`const b = (window.__mcplaneHits || [])[${i}]; if (!b) return false; b.scrollIntoView({ block: 'nearest' }); b.click(); return true;`);
    await this.wait(500);
    return this.page<string>(`
      const c = composer();
      if (!c) return '';
      const p = c.querySelector('[' + UI.mentionAttr + ']');
      if (p) return p.getAttribute(UI.mentionAttr) || 'mentioned';
      return c.textContent.trim() ? 'mentioned' : '';`);
  }

  /**
   * @mentions the plugin through the + menu, so the test talks to it. When several
   * plugins share the name (the directory version and your developer-mode one),
   * the developer-mode one wins, since that's what review wants to see.
   */
  async mention(name: string): Promise<{ ok: boolean; devMode: boolean; choices: number }> {
    // The plugin list can arrive after the menu does, so look again for a few seconds.
    const deadline = Date.now() + 15_000;
    let hits = await this.pluginEntries(name);
    while (!hits.length && Date.now() < deadline) {
      await this.key('Escape', 'Escape', 27);
      await this.wait(1_000);
      hits = await this.pluginEntries(name);
    }
    if (!hits.length) {
      await this.key('Escape', 'Escape', 27);
      return { ok: false, devMode: false, choices: 0 };
    }
    const order = this.pluginPick && this.pluginPick.index < hits.length ? [this.pluginPick.index, ...hits.keys()] : [...hits.keys()];
    let first: { index: number; path: string } | null = null;
    let menuOpen = true;
    for (const i of [...new Set(order)]) {
      if (!menuOpen) {
        await this.clearComposer();
        await this.pluginEntries(name);
      }
      const path = await this.pickEntry(i);
      menuOpen = false;
      if (!path) continue;
      first ??= { index: i, path };
      if (path.includes(UI.devMode) || hits.length === 1 || this.pluginPick?.path === path) {
        this.pluginPick = { index: i, path };
        return { ok: true, devMode: path.includes(UI.devMode), choices: hits.length };
      }
    }
    if (!first) return { ok: false, devMode: false, choices: hits.length };
    // None is in developer mode: use the first one.
    await this.clearComposer();
    await this.pluginEntries(name);
    await this.pickEntry(first.index);
    this.pluginPick = first;
    return { ok: true, devMode: false, choices: hits.length };
  }

  /** Types like a person would, so the video shows the prompt being written. */
  async type(text: string) {
    await this.page('const c = composer(); if (!c) return false; if (!c.contains(document.activeElement)) c.focus(); return true;');
    for (const ch of text.replace(/\s*\n\s*/g, ' ')) {
      await this.cdp.send('Input.insertText', { text: ch });
      await this.wait(18 + Math.round(Math.random() * 30));
    }
  }

  async send() {
    if (await this.click(UI.send)) return;
    await this.key('Enter', 'Enter', 13, 0, '\r');
  }

  /**
   * Waits for the answer to finish: the Stop button gone and the page still for a
   * moment. Approval cards are clicked with --approve, otherwise left to you.
   */
  async waitForReply(o: { approve: boolean; log: (s: string) => void }): Promise<'done' | 'timeout'> {
    const start = Date.now();
    let busySeen = false;
    let quietSince = 0;
    let lastText = -1;
    let told = false;
    while (Date.now() - start < REPLY_TIMEOUT) {
      const s = await this.page<{ busy: boolean; approval: boolean; text: number }>(
        'const ls = buttons().map(label); return { busy: ls.some((l) => UI.stop.includes(l)), approval: ls.some((l) => UI.approval.includes(l)), text: document.body.innerText.length };',
      );
      const now = Date.now();
      if (s.approval) {
        quietSince = 0;
        if (o.approve) {
          if (await this.click(UI.allow)) o.log('    approved a tool call (Allow once)');
        } else if (!told) {
          o.log('    ChatGPT is asking to run a tool: approve or deny it in the app (or run again with --approve)');
          told = true;
        }
      } else if (s.busy) {
        busySeen = true;
        quietSince = 0;
      } else {
        if (s.text !== lastText || !quietSince) quietSince = now;
        if ((busySeen || now - start > 15_000) && now - quietSince >= 2_500) return 'done';
      }
      lastText = s.text;
      await this.wait(300);
    }
    return 'timeout';
  }

  /** Opens the "Worked for…" summary so the video shows which tools ran. */
  async showActivity(): Promise<boolean> {
    const p = await this.page<Point | null>(`
      const re = new RegExp(UI.activity);
      const b = buttons().filter((b) => b.getAttribute('aria-expanded') === 'false' && re.test(label(b))).pop();
      return b ? center(b) : null;`);
    if (!p) return false;
    await this.clickAt(p);
    return true;
  }

  /** Starts recording the window; the returned function stops it and hands back the frames. */
  async record(work: string): Promise<() => Promise<{ frames: Frame[]; end: number }>> {
    const frames: Frame[] = [];
    let offset: number | null = null;
    const off = this.cdp.on('Page.screencastFrame', (p) => {
      const now = Date.now() / 1000;
      const shown = typeof p.metadata?.timestamp === 'number' ? p.metadata.timestamp : now;
      // Keep the compositor's timing between frames, aligned to this clock.
      offset ??= now - shown;
      const file = `frames/f${String(++this.frameNo).padStart(6, '0')}.jpg`;
      // Written before the ack, so ChatGPT never sends frames faster than they reach the disk.
      writeFileSync(join(work, file), Buffer.from(p.data, 'base64'));
      frames.push({ file, ts: shown + offset });
      this.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => null);
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1920, maxHeight: 1200, everyNthFrame: 1 });
    return async () => {
      await this.cdp.send('Page.stopScreencast').catch(() => null);
      const end = Date.now() / 1000;
      off();
      return { frames, end };
    };
  }
}

/** "1,3" or "2-4" to zero-based indexes into the positive tests, in the order given. */
export function pickTests(count: number, only?: string): number[] {
  if (!only) return [...Array(count).keys()];
  const picked: number[] = [];
  for (const part of only.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`--only takes test numbers like 1,3 or 2-4, not "${part}".`);
    const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
    for (let n = a; n <= b; n++) {
      if (n < 1 || n > count) throw new Error(`There is no positive test ${n}; mcplane.json has ${count}.`);
      if (!picked.includes(n - 1)) picked.push(n - 1);
    }
  }
  if (!picked.length) throw new Error('--only picked no tests.');
  return picked;
}

const isRunning = () => spawnSync('pgrep', ['-f', `^${BINARY}`]).status === 0;
const osascript = (script: string) => spawnSync('osascript', ['-e', script], { stdio: 'ignore' });

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error('mcplane demo asks before it drives ChatGPT. Run it in a terminal, or pass --yes.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export interface DemoOptions {
  /** Positive tests to record, e.g. "1,3" (default: all). */
  only?: string;
  /** Where to write the video (default: .mcplane/packs/chatgpt/demo.mp4). */
  out?: string;
  /** Click "Allow once" on tool approval cards. */
  approve?: boolean;
  /** Leave ChatGPT running afterwards (it keeps its debugging port open until you quit it). */
  keepOpen?: boolean;
  /** Don't ask first. */
  yes?: boolean;
  /** The plugin to @mention (default: the manifest's title). */
  plugin?: string;
  /** Record in Work mode instead of Chat. */
  work?: boolean;
  port?: number;
  token?: string;
  dir?: string;
  log?: (line: string) => void;
}

export interface DemoResult {
  out: string;
  seconds: number;
  scenes: number;
  notes: string[];
}

export async function demo(m: Manifest, o: DemoOptions = {}): Promise<DemoResult> {
  const log = o.log ?? ((s: string) => console.log(s));
  const dir = o.dir ?? process.cwd();
  const port = o.port ?? PORT;
  if (process.platform !== 'darwin') throw new Error('mcplane demo records the ChatGPT desktop app, which runs on macOS.');
  if (!existsSync(BINARY)) throw new Error(`mcplane demo needs the ChatGPT desktop app in ${APP}.`);
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('mcplane demo needs ffmpeg to make the video: brew install ffmpeg');

  const all = m.tests?.positive ?? [];
  if (!all.length) throw new Error('mcplane.json has no tests.positive to record. The onboard prompt writes them.');
  const tests = pickTests(all.length, o.only).map((i) => ({ n: i + 1, ...all[i] }));
  const plugin = o.plugin ?? m.title;
  const mode = o.work ? UI.workMode : UI.chatMode;
  const tools: Tool[] | null = await listTools(m, o.token).catch(() => null);
  const writes = new Set((tools ?? []).filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name));

  if (!o.yes) {
    log(`mcplane demo drives ChatGPT on this Mac, signed in as you, and records its window.`);
    log(`For each test it opens a new chat in ${mode} mode, @mentions ${plugin} and sends:`);
    for (const t of tests) {
      const w = t.tools.filter((n) => writes.has(n));
      log(`  ${t.n}. ${t.prompt}${w.length ? `  (calls ${w.join(', ')}, which writes)` : ''}`);
    }
    if (!tools) log(`(Couldn't read the server's tools, so tests that write aren't marked.)`);
    log('The sidebar, with your chats and name, is hidden before recording. The chats stay in your history.');
    log('Answers can draw on your ChatGPT memory and past chats, so watch the video before you share it.');
    log(o.approve ? 'If ChatGPT asks to run a tool, mcplane clicks "Allow once".' : 'If ChatGPT asks to run a tool, you approve or deny it in the app.');
    if (!(await confirm('Continue? (y/N) '))) throw new Error('Nothing recorded.');
  }

  const ac = new AbortController();
  const stop = () => ac.abort(new Error('Stopped.'));
  process.once('SIGINT', stop);
  const work = await mkdtemp(join(tmpdir(), 'mcplane-demo-'));
  await mkdir(join(work, 'frames'));
  const notes: string[] = [];
  const scenes: Scene[] = [];
  let launched = false;
  let cdp: Cdp | null = null;
  let recorded = false;

  try {
    // Attach to a ChatGPT already listening on the port, or start one that does.
    const existing = await listTargets(port).catch(() => null);
    if (existing && !pickMainWindow(existing, MAIN_WINDOW)) throw new Error(`Port ${port} is in use by something other than ChatGPT. Pass --port to use another.`);
    if (!existing) {
      if (isRunning()) throw new Error('ChatGPT is open without a debugging port. Quit it (Cmd+Q) and run mcplane demo again: it reopens ChatGPT with one, and quits it afterwards.');
      log('Opening ChatGPT…');
      // Electron refuses some NODE_OPTIONS (e.g. --openssl-legacy-provider) and crashes on start.
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      spawn(BINARY, [`--remote-debugging-port=${port}`, ...KEEP_RENDERING], { env, detached: true, stdio: 'ignore' }).unref();
      launched = true;
    }
    const deadline = Date.now() + (launched ? 60_000 : 5_000);
    let target = existing ? pickMainWindow(existing, MAIN_WINDOW) : undefined;
    while (!target) {
      if (Date.now() > deadline) throw new Error("ChatGPT's window didn't appear.");
      await sleep(500, undefined, { signal: ac.signal });
      target = pickMainWindow((await listTargets(port).catch(() => null)) ?? [], MAIN_WINDOW);
    }
    cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
    osascript(`tell application "${APP}" to activate`);
    const app = new Desktop(cdp, ac.signal);
    await app.ready();

    const sidebarWasOpen = await app.sidebarOpen();
    let modeWas: string | null = null;
    let devModeNoted = false;
    try {
      for (const [i, t] of tests.entries()) {
        log(`${i + 1}/${tests.length}  ${t.scenario}`);
        await app.newChat();
        const was = await app.setMode(mode);
        if (i === 0) modeWas = was;
        const mention = await app.mention(plugin);
        // Without the @mention ChatGPT may answer from the web instead, and the video shows nothing of yours.
        if (!mention.ok) throw new Error(`There's no plugin called "${plugin}" in ChatGPT's + menu, so nothing was sent. Connect it in developer mode, or pass --plugin with the name ChatGPT shows.`);
        if (!mention.devMode && !devModeNoted) {
          notes.push(`@${plugin} isn't a developer-mode plugin${mention.choices > 1 ? ' (none of the ones with that name are)' : ''}. Review asks for a recording in developer mode.`);
          devModeNoted = true;
        }
        if (await app.sidebarOpen()) await app.hideSidebar(); // never record the sidebar

        const finish = await app.record(work);
        let result: 'done' | 'timeout' = 'timeout';
        try {
          await sleep(1_200, undefined, { signal: ac.signal });
          await app.type(t.prompt);
          await sleep(500, undefined, { signal: ac.signal });
          await app.send();
          const sent = Date.now();
          result = await app.waitForReply({ approve: !!o.approve, log });
          log(result === 'done' ? `    answered in ${Math.round((Date.now() - sent) / 1000)}s` : `    still going after ${REPLY_TIMEOUT / 60_000} minutes; moving on`);
          await sleep(800, undefined, { signal: ac.signal });
          if (await app.showActivity()) await sleep(600, undefined, { signal: ac.signal });
          await sleep(2_500, undefined, { signal: ac.signal });
        } finally {
          const { frames, end } = await finish();
          scenes.push({ caption: t.scenario, frames, end });
        }
        if (result === 'timeout') notes.push(`Test ${t.n} was still running after ${REPLY_TIMEOUT / 60_000} minutes; its scene ends there.`);
      }
      recorded = true;
    } finally {
      // Put the window back the way it was: mode, then sidebar.
      if (!ac.signal.aborted) {
        try {
          if (modeWas && modeWas !== mode) {
            await app.newChat();
            await app.setMode(modeWas);
          }
          if (sidebarWasOpen) await app.showSidebar();
        } catch {
          // Cosmetic; never fail a recording over it.
        }
      }
    }
  } catch (e) {
    throw ac.signal.aborted ? new Error('Stopped. Nothing was saved.') : e;
  } finally {
    process.removeListener('SIGINT', stop);
    cdp?.close();
    if (launched && !o.keepOpen) {
      osascript(`quit app "${APP}"`);
      for (let i = 0; i < 30 && isRunning(); i++) await sleep(500);
      if (isRunning()) log(`ChatGPT is still running with its debugging port (${port}) open. Quit it yourself.`);
    } else if (launched || cdp) {
      log(`ChatGPT is still running with its debugging port (${port}) open, so any program on this Mac can drive it. Quit it when you're done.`);
    }
    if (!recorded) await rm(work, { recursive: true, force: true });
  }

  try {
    const first = scenes.find((s) => s.frames.length)?.frames[0];
    if (!first) throw new Error('No frames were recorded.');
    const size = jpegSize(await readFile(join(work, first.file)));
    if (!size) throw new Error(`Couldn't read the size of ${first.file}.`);
    const out = resolve(dir, o.out ?? '.mcplane/packs/chatgpt/demo.mp4');
    if (!o.out) await ensureLocalDir(dir);
    await mkdir(dirname(out), { recursive: true });
    const seconds = await buildVideo({
      scenes: scenes.filter((s) => s.frames.length),
      title: `${m.title} in ChatGPT`,
      subtitle: m.subtitle ?? m.oneLiner,
      out,
      work,
      ffmpeg,
      size: outputSize(size.width, size.height),
    });
    await rm(work, { recursive: true, force: true });
    if (tools) {
      const shown = new Set(tests.flatMap((t) => t.tools));
      const missing = tools.map((t) => t.name).filter((n) => !shown.has(n));
      if (missing.length) notes.push(`Not shown: ${missing.join(', ')}. Review wants the video to cover the tools your tests use.`);
    }
    return { out, seconds, scenes: scenes.length, notes };
  } catch (e) {
    throw new Error(`${(e as Error).message} The recorded frames are in ${work}; delete it when you're done.`);
  }
}

export const _test = { pickTests, PAGE };
