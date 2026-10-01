import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeFrames, encodeFrame, pickMainWindow, type Target } from '../src/cdp.js';
import { _test as demo } from '../src/demo.js';
import { concatList, ffEscape, findFfmpeg, inkFor, jpegSize, outputSize, sceneSeconds, wrapCaption } from '../src/video.js';

test('concatList holds each frame until the next and the last until the end', () => {
  const list = concatList(
    [
      { file: 'frames/f000002.jpg', ts: 100.5 },
      { file: 'frames/f000001.jpg', ts: 100 },
      { file: "frames/it's.jpg", ts: 101.25 },
    ],
    104,
  );
  assert.equal(
    list,
    [
      "file 'frames/f000001.jpg'",
      'duration 0.500',
      "file 'frames/f000002.jpg'",
      'duration 0.750',
      "file 'frames/it'\\''s.jpg'",
      'duration 2.750',
      "file 'frames/it'\\''s.jpg'",
      '',
    ].join('\n'),
  );
});

test('concatList still shows a frame that arrives after the stop time', () => {
  const list = concatList([{ file: 'a.jpg', ts: 10 }], 9.9);
  assert.match(list, /duration 0\.033/);
  assert.throws(() => concatList([], 1), /No frames/);
});

test('sceneSeconds runs from the first frame to the stop time', () => {
  assert.equal(sceneSeconds({ caption: '', frames: [{ file: 'a', ts: 12 }, { file: 'b', ts: 10 }], end: 15 }), 5);
  assert.equal(sceneSeconds({ caption: '', frames: [], end: 15 }), 0);
});

test('ffEscape quotes both levels of an ffmpeg filtergraph', () => {
  // The worked example from ffmpeg's filter documentation.
  assert.equal(ffEscape("this is a 'string': may contain one, or more, special characters"), "this is a \\\\\\'string\\\\\\'\\\\: may contain one\\, or more\\, special characters");
  assert.equal(ffEscape('/System/Library/Fonts/SFNS.ttf'), '/System/Library/Fonts/SFNS.ttf');
  assert.equal(ffEscape('a[b];c'), 'a\\[b\\]\\;c');
});

test('wrapCaption fits captions on two lines and says when it cut', () => {
  assert.deepEqual(wrapCaption("Check one store's current review time"), ["Check one store's current review time"]);
  assert.deepEqual(wrapCaption('one two three four', 9), ['one two', 'three…']);
  assert.deepEqual(wrapCaption('alpha beta gamma delta', 11), ['alpha beta', 'gamma delta']);
  assert.deepEqual(wrapCaption('tab\there\nnew line', 64), ['tab here new line']);
  assert.ok(wrapCaption('word '.repeat(60)).every((l) => l.length <= 64));
  assert.ok(wrapCaption('word '.repeat(60)).at(-1)!.endsWith('…'));
});

test('jpegSize reads the frame size from the start-of-frame marker', () => {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0)];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0xb0, 0x07, 0x75, 0x03, ...Array(9).fill(0)];
  assert.deepEqual(jpegSize(new Uint8Array([0xff, 0xd8, ...app0, ...sof0])), { width: 1909, height: 1200 });
  assert.equal(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
});

test('outputSize keeps the aspect ratio with even sides', () => {
  assert.deepEqual(outputSize(1909, 1200), { width: 1908, height: 1200 });
  assert.deepEqual(outputSize(3016, 1896), { width: 1908, height: 1200 });
  assert.deepEqual(outputSize(1281, 801), { width: 1280, height: 800 });
});

test('inkFor picks text that reads on the app’s background', () => {
  assert.equal(inkFor('0x1a1a1a').text, 'white');
  assert.equal(inkFor('#ffffff').text, '0x1d1d1f');
  assert.equal(inkFor('0xf9f9f9').muted, '0x5f6673');
});

test('pickMainWindow finds ChatGPT’s main window, not its other windows, webviews or MCP App iframes', () => {
  const t = (type: string, url: string, ws = true): Target => ({ id: url, type, title: '', url, ...(ws ? { webSocketDebuggerUrl: `ws://x/${url}` } : {}) });
  // What ChatGPT desktop 26.903 lists on its debugging port, plus an MCP App iframe.
  const others = [
    t('webview', 'https://chatgpt.com/?source=codex-embedded-checkout#pricing'),
    t('page', 'app://-/index.html?initialRoute=%2Favatar-overlay'),
    t('iframe', 'codex-sandbox://abc.web-sandbox.oaiusercontent.com/'),
  ];
  assert.equal(pickMainWindow([...others, t('page', 'app://-/index.html')], 'app://-/index.html')?.url, 'app://-/index.html');
  assert.equal(pickMainWindow(others, 'app://-/index.html'), undefined);
  assert.equal(pickMainWindow([t('page', 'app://-/index.html', false)], 'app://-/index.html'), undefined);
});

test('WebSocket frames round-trip at every length encoding, masked from the client', () => {
  for (const n of [0, 5, 125, 126, 65_535, 65_536, 300_000]) {
    const payload = Buffer.alloc(n, 'x');
    const frame = encodeFrame(payload, 0x1, Buffer.from([1, 2, 3, 4]));
    assert.equal(frame[1] & 0x80, 0x80, 'client frames are masked');
    const { frames, rest } = decodeFrames(frame);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].fin, true);
    assert.equal(frames[0].opcode, 0x1);
    assert.ok(frames[0].payload.equals(payload), `payload of ${n} bytes`);
    assert.equal(rest.length, 0);
  }
});

test('decodeFrames waits for a partial frame and reads unmasked server frames', () => {
  const server = (text: string, fin = true, opcode = 0x1) => Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, text.length]), Buffer.from(text)]);
  const both = Buffer.concat([server('{"id":1', false), server('}', true, 0x0), server('{"id":2}')]);
  const { frames, rest } = decodeFrames(both.subarray(0, both.length - 3));
  assert.deepEqual(frames.map((f) => [f.fin, f.opcode, f.payload.toString()]), [[false, 1, '{"id":1'], [true, 0, '}']]);
  assert.equal(decodeFrames(Buffer.concat([rest, both.subarray(both.length - 3)])).frames[0].payload.toString(), '{"id":2}');
});

test('pickTests reads --only as numbers and ranges, in order, once each', () => {
  assert.deepEqual(demo.pickTests(5), [0, 1, 2, 3, 4]);
  assert.deepEqual(demo.pickTests(5, '1,3'), [0, 2]);
  assert.deepEqual(demo.pickTests(5, '4-5, 1'), [3, 4, 0]);
  assert.deepEqual(demo.pickTests(5, '3,1,3'), [2, 0]);
  assert.throws(() => demo.pickTests(5, '6'), /no positive test 6/);
  assert.throws(() => demo.pickTests(5, 'one'), /test numbers/);
});

test('the page helpers are valid JavaScript', () => {
  assert.doesNotThrow(() => new Function('UI', `${demo.PAGE}\nreturn [vis, label, buttons, button, center, composer];`));
});

test('findFfmpeg looks on PATH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcplane-ff-'));
  await writeFile(join(dir, 'ffmpeg'), '');
  assert.equal(findFfmpeg(dir), join(dir, 'ffmpeg'));
  await rm(dir, { recursive: true });
});
