// Capture Chrome Web Store listing screenshots for the extension.
//
// Produces 1280×800 PNGs that meet the Web Store's spec:
//   - 1280×800 viewport (the listing form's preferred size)
//   - 24-bit PNG, no alpha channel (we re-encode through our PNG
//     writer to drop the alpha so the dev console accepts them)
//   - JPEG would also work but PNG is lossless and our images are
//     small + flat, so PNG compresses well
//
// Output:
//   dist-extension/screenshots/01-prompt.png   — the after-game prompt
//                                                in action
//   dist-extension/screenshots/02-options.png  — the options page with
//                                                the Test-connection
//                                                success state
//
// Run:
//   node scripts/screenshot-extension.mjs
//
// Doesn't require `npm run dev`. The deep-link in the prompt is
// built but we don't follow it. The options-page screenshot
// stubs `chrome.permissions.request` and a fetch to fake the
// "Connected ✓" state without needing a real backend.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(REPO_ROOT, 'extension');
const OUT_DIR = path.join(REPO_ROOT, 'dist-extension', 'screenshots');
const VIEWPORT = { width: 1280, height: 800 };


/**
 * Synthetic chess.com end-of-game page. Designed to read as
 * "finished chess game" at a glance in the screenshot:
 *   - Dark green board background mimicking chess.com's dark theme.
 *   - 8×8 grid with Unicode chess pieces in a recognisable mate
 *     pattern (back-rank mate — Black king on h8, White rook on h1,
 *     White king tucked away). Feels like a real game without
 *     copying chess.com's actual board widget.
 *   - A right-rail card with "1-0" and "Game Review" button, mirroring
 *     the layout chess.com uses post-game. The `class="game-result"`
 *     trips the content script into showing the prompt.
 *
 * The Chess Coach prompt overlays the bottom-right corner, where
 * chess.com's own UI tends to be empty after a game — natural fit.
 */
const SYNTH_GAME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Chess game · Chess.com</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #312e2b;
      color: #e6e8eb;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 24px;
      padding: 24px;
    }
    .topbar {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 48px;
      background: #262421;
      border-bottom: 1px solid #1f1d1b;
      display: flex;
      align-items: center;
      padding: 0 24px;
      font-weight: 600;
      color: #b6b1ad;
      font-size: 14px;
      letter-spacing: 0.5px;
    }
    .topbar .brand { color: #e6e8eb; }
    main {
      display: flex;
      gap: 24px;
      align-items: flex-start;
      margin-top: 32px;
    }
    .board-wrap {
      width: 560px;
    }
    .player {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 4px; color: #e6e8eb; font-size: 14px;
    }
    .player .avatar {
      width: 28px; height: 28px; border-radius: 4px;
      background: #4b4845; display: inline-block;
    }
    .player .name { font-weight: 600; }
    .player .rating { color: #8b8786; font-weight: 400; }
    .board {
      width: 560px; height: 560px;
      display: grid;
      grid-template-columns: repeat(8, 1fr);
      grid-template-rows: repeat(8, 1fr);
      border-radius: 4px;
      overflow: hidden;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    }
    .sq {
      display: flex; align-items: center; justify-content: center;
      font-size: 56px; line-height: 1;
      user-select: none;
    }
    .light { background: #ebecd0; }
    .dark { background: #739552; }
    .last-move-from { background: #f6f669 !important; }
    .last-move-to { background: #baca44 !important; }
    .white { color: #fafafa; text-shadow: 0 1px 2px rgba(0,0,0,0.4); }
    .black { color: #2b2b2b; }
    aside {
      width: 360px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .panel {
      background: #262421;
      border: 1px solid #1f1d1b;
      border-radius: 6px;
      padding: 18px;
    }
    .game-result-panel {
      text-align: center;
      padding: 24px 18px 18px;
    }
    .game-result {
      display: inline-block;
      font-size: 32px;
      font-weight: 800;
      letter-spacing: 1px;
      color: #fafafa;
      margin-bottom: 4px;
    }
    .verdict {
      font-size: 13px;
      color: #b6b1ad;
      margin-bottom: 18px;
    }
    .review-btn {
      display: inline-block;
      background: #81b64c;
      color: #fff;
      border: 0;
      border-radius: 4px;
      padding: 12px 22px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .moves-panel { padding: 16px 18px; }
    .moves-panel h3 {
      font-size: 12px; text-transform: uppercase;
      letter-spacing: 1px; color: #8b8786;
      margin-bottom: 8px; font-weight: 700;
    }
    .moves {
      display: grid;
      grid-template-columns: 30px 1fr 1fr;
      gap: 4px 12px;
      font-size: 13px;
      color: #d6d2cf;
      font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
    }
    .moves .num { color: #8b8786; }
  </style>
</head>
<body>
  <div class="topbar"><span class="brand">Chess.com</span></div>
  <main>
    <div class="board-wrap">
      <div class="player"><span class="avatar"></span><span class="name">VillainOpponent</span> <span class="rating">(1487)</span></div>
      <div class="board" id="board"></div>
      <div class="player"><span class="avatar"></span><span class="name">HeroUser</span> <span class="rating">(1512)</span></div>
    </div>
    <aside>
      <div class="panel game-result-panel">
        <div class="game-result">1–0</div>
        <div class="verdict">HeroUser won by checkmate</div>
        <button class="review-btn">Game Review</button>
      </div>
      <div class="panel moves-panel">
        <h3>Moves</h3>
        <div class="moves">
          <span class="num">1.</span><span>e4</span><span>e5</span>
          <span class="num">2.</span><span>Nf3</span><span>Nc6</span>
          <span class="num">3.</span><span>Bc4</span><span>Bc5</span>
          <span class="num">4.</span><span>O-O</span><span>Nf6</span>
          <span class="num">5.</span><span>d3</span><span>d6</span>
          <span class="num">6.</span><span>h3</span><span>h6</span>
          <span class="num">7.</span><span>Re1</span><span>O-O</span>
          <span class="num">8.</span><span>Nbd2</span><span>Bg4</span>
          <span class="num">9.</span><span>hxg4</span><span>Nxg4</span>
          <span class="num">10.</span><span>Qe2</span><span>Nf6</span>
          <span class="num">11.</span><span>Nf1</span><span>Nh5</span>
          <span class="num">12.</span><span>Ng3</span><span>Nf4</span>
          <span class="num">13.</span><span>Bxf4</span><span>exf4</span>
          <span class="num">14.</span><span>Nh5</span><span>g6</span>
          <span class="num">15.</span><span>Qg4#</span><span></span>
        </div>
      </div>
    </aside>
  </main>
  <script>
    // Render a back-rank-mate-ish position. Pieces drawn from a
    // simple grid string; '.' = empty, 'KQRBNPkqrbnp' = the obvious.
    // White is uppercase. We're not validating the position — just
    // need it to look like a mid-late-game scene that ended with
    // mate on h8.
    const POS = [
      'r....rk.', // rank 8 — Black king with rook still on a8
      'pp.....p', // rank 7
      '..pp.npP', // rank 6
      '....p...', // rank 5
      '..B.Pp..', // rank 4
      '...P.NN.', // rank 3
      'PPP..PP.', // rank 2 — pawn structure
      'R...R.K.', // rank 1
    ];
    const PIECE = {
      K: '\u2654', Q: '\u2655', R: '\u2656', B: '\u2657', N: '\u2658', P: '\u2659',
      k: '\u265A', q: '\u265B', r: '\u265C', b: '\u265D', n: '\u265E', p: '\u265F',
    };
    const board = document.getElementById('board');
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const sq = document.createElement('div');
        sq.className = 'sq ' + (((r + f) % 2 === 0) ? 'light' : 'dark');
        // highlight Qg4 → h5 last-move (file g rank 4 → file h rank 5)
        if (r === 4 && f === 6) sq.classList.add('last-move-from');
        if (r === 3 && f === 7) sq.classList.add('last-move-to');
        const ch = POS[r][f];
        if (ch !== '.') {
          const span = document.createElement('span');
          span.textContent = PIECE[ch];
          span.className = ch === ch.toUpperCase() ? 'white' : 'black';
          sq.appendChild(span);
        }
        board.appendChild(sq);
      }
    }
  </script>
</body>
</html>`;


// ── Alpha-stripping PNG re-encoder ────────────────────────────────
//
// Playwright's `page.screenshot()` writes an RGBA PNG (color type 6).
// The Chrome Web Store dev console specifies "24-bit PNG (no alpha)",
// which is color type 2 (RGB). Some uploads of color-type-6 PNGs get
// rejected with a generic "format not supported" error. To avoid
// that, we re-encode the PNG bytes through a minimal reader/writer
// pipeline that drops the alpha channel (with a white background
// composite if any pixels are <100% opaque — for a real screenshot
// of an opaque page this is a no-op, but it makes the encoder robust
// to overlays that happen to be translucent).
//
// We already have the encoder side from build-extension-icons.mjs;
// the reader uses node:zlib's inflate to undo Playwright's deflate.

function readPNGRGBA(buf) {
  // Validate signature.
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error('readPNGRGBA: bad PNG signature');
  }
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  /** @type {Buffer[]} */
  const idatChunks = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); off += 4;
    const type = buf.toString('ascii', off, off + 4); off += 4;
    const data = buf.subarray(off, off + len); off += len;
    off += 4; // skip CRC
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error('readPNGRGBA: unsupported compression/filter/interlace');
      }
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(
      `readPNGRGBA: only 8-bit RGB/RGBA supported (got bitDepth=${bitDepth} colorType=${colorType})`,
    );
  }
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  // Undo PNG row filters. We expect mostly filter-0 (None) and
  // filter-1 (Sub) / filter-2 (Up) from Playwright. Implement all 5
  // for safety.
  const raw = Buffer.alloc(stride * height);
  let prevRow = Buffer.alloc(stride);
  let inOff = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[inOff++];
    const row = inflated.subarray(inOff, inOff + stride);
    inOff += stride;
    const out = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = prevRow[x];
      const upLeft = x >= channels ? prevRow[x - channels] : 0;
      let recon;
      switch (filter) {
        case 0: recon = row[x]; break;
        case 1: recon = (row[x] + left) & 0xff; break;
        case 2: recon = (row[x] + up) & 0xff; break;
        case 3: recon = (row[x] + Math.floor((left + up) / 2)) & 0xff; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          recon = (row[x] + paeth) & 0xff;
          break;
        }
        default: throw new Error('readPNGRGBA: unknown filter ' + filter);
      }
      out[x] = recon;
    }
    out.copy(raw, y * stride);
    prevRow = out;
  }
  // Promote RGB→RGBA for uniformity downstream.
  if (channels === 4) return { width, height, rgba: raw };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
    rgba[j] = raw[i];
    rgba[j + 1] = raw[i + 1];
    rgba[j + 2] = raw[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let k = n;
      for (let i = 0; i < 8; i++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1;
      t[n] = k >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    crc = (crc >>> 8) ^ table[c];
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Encode an RGB pixel buffer (no alpha) as a 24-bit PNG, color
 * type 2. Composites RGBA → RGB against a white background.
 */
function encodeRGB24(rgba, width, height) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3] / 255;
    // Composite over white. For fully-opaque inputs (a=1) this is a
    // no-op; for translucent overlays it produces the same look the
    // user saw on the white-bg screenshot.
    rgb[j]     = Math.round(rgba[i]     * a + 255 * (1 - a));
    rgb[j + 1] = Math.round(rgba[i + 1] * a + 255 * (1 - a));
    rgb[j + 2] = Math.round(rgba[i + 2] * a + 255 * (1 - a));
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;          // bit depth
  ihdr[9] = 2;          // color type: 2 = RGB (truecolor, no alpha)
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Read an RGBA PNG file at `inPath`, write a 24-bit RGB PNG to
 *  `outPath` of the same dimensions, return the new size. */
async function flattenPng(inPath, outPath) {
  const inBuf = await fs.readFile(inPath);
  const { width, height, rgba } = readPNGRGBA(inBuf);
  const rgb = encodeRGB24(rgba, width, height);
  await fs.writeFile(outPath, rgb);
  return { width, height, bytes: rgb.length };
}


async function capturePromptShot(ctx) {
  const page = await ctx.newPage();
  await page.setViewportSize(VIEWPORT);

  // Stub the chess.com URL — same trick as scripts/test/integration/extension.mjs.
  await page.route('https://www.chess.com/**', async (route) => {
    if (route.request().resourceType() === 'document') {
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: SYNTH_GAME_HTML,
      });
    }
    return route.fulfill({ status: 204, body: '' });
  });

  await page.goto('https://www.chess.com/game/172800123456', {
    waitUntil: 'domcontentloaded',
  });
  // The content script's heartbeat is ~1500 ms, plus small render
  // animations. 3 s settles everything visually.
  await page.waitForSelector('#chess-coach-prompt', { timeout: 8000 });
  await page.waitForTimeout(1200);

  const tmp = path.join(OUT_DIR, '01-prompt.rgba.png');
  const final = path.join(OUT_DIR, '01-prompt.png');
  await page.screenshot({ path: tmp, fullPage: false });
  await page.close();
  await flattenPng(tmp, final);
  await fs.rm(tmp);
  return final;
}

/**
 * Synthetic options-page screenshot.
 *
 * The options page is served by the extension itself at
 * `chrome-extension://<id>/src/options.html`. To get a clean
 * "Connected ✓" state without booting a real backend, we:
 *   1. Pre-fill the form via chrome.storage.sync (so the username +
 *      coachOrigin show up populated).
 *   2. Stub `chrome.permissions.request` to resolve `true` and
 *      override `window.fetch` to return a 200 with a body that
 *      contains "Chess Coach", so the Test-connection handler
 *      reports the green-tick state.
 *   3. Click "Test connection" and capture once the status renders.
 */
async function captureOptionsShot(ctx) {
  // Find the extension id via the service worker URL.
  const svc = ctx.serviceWorkers()[0];
  const extId = new URL(svc.url()).hostname;
  const optionsUrl = `chrome-extension://${extId}/src/options.html`;

  const page = await ctx.newPage();
  await page.setViewportSize(VIEWPORT);
  // Stub fetch + permissions on the options page itself before
  // navigation so the initial script doesn't see real APIs.
  await page.addInitScript(() => {
    window.__originalFetch = window.fetch;
    window.fetch = async () => {
      return new Response(
        '<!doctype html><title>Chess Coach</title>',
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    };
    // chrome.permissions.request must come from the extension page's
    // own `chrome` object; intercept after DOMContentLoaded since the
    // background contexts inject it.
    document.addEventListener('DOMContentLoaded', () => {
      try {
        // eslint-disable-next-line no-undef
        if (chrome?.permissions) {
          // eslint-disable-next-line no-undef
          chrome.permissions.request = (_perms, cb) => {
            if (typeof cb === 'function') cb(true);
            return Promise.resolve(true);
          };
        }
      } catch { /* ignore */ }
    }, { once: true });
  });

  await page.goto(optionsUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);

  // Focus the primary inputs so the form looks "filled in".
  await page.fill('#username', 'HeroUser');
  await page.fill('#coachOrigin', 'https://chess-coach-bip.pages.dev');
  await page.click('#test');
  // Wait for the status text to update to the green path.
  await page.waitForFunction(
    () => /Connected/i.test(document.getElementById('status')?.textContent || ''),
    { timeout: 5000 },
  );
  await page.waitForTimeout(300);

  const tmp = path.join(OUT_DIR, '02-options.rgba.png');
  const final = path.join(OUT_DIR, '02-options.png');
  await page.screenshot({ path: tmp, fullPage: false });
  await page.close();
  await flattenPng(tmp, final);
  await fs.rm(tmp);
  return final;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chess-coach-shot-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: VIEWPORT,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // Pre-seed storage so the prompt-shot has a username and the
  // options-shot has the inputs already populated when the page
  // mounts.
  const svc = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  await svc.evaluate(async () => {
    return new Promise((resolve) => {
      // eslint-disable-next-line no-undef
      chrome.storage.sync.set(
        {
          coachOrigin: 'https://chess-coach-bip.pages.dev',
          chesscomUsername: 'HeroUser',
          enabled: true,
        },
        () => resolve(),
      );
    });
  });

  const prompt = await capturePromptShot(ctx);
  console.log(`✓ ${path.relative(REPO_ROOT, prompt)}`);
  const options = await captureOptionsShot(ctx);
  console.log(`✓ ${path.relative(REPO_ROOT, options)}`);

  await ctx.close();
  await fs.rm(userDataDir, { recursive: true, force: true });

  console.log('\nUpload these in the Web Store dev console → Graphic assets.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
