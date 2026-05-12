// Generate the chrome-extension icons (16/32/48/128) without depending
// on any native image library. Pure Node + node:zlib.
//
// Why this exists:
//   - The Chrome Web Store requires a 128×128 PNG for the listing.
//   - Toolbar/management UIs render 16, 32, 48 from the manifest's
//     `icons` block. Without these, Chrome shows a generic puzzle
//     piece, which screams "unfinished extension" to anyone browsing.
//   - We don't want to add `sharp`, `canvas`, or `librsvg` as deps
//     just for four PNGs that effectively never change.
//
// What it draws:
//   A dark rounded square (matches the app's `bg` color) with a
//   stylised stepped chess-knight glyph in light grey. The knight is
//   built from a small fixed grid of "on/off" cells scaled to fit
//   each target size, so the silhouette stays crisp at every size.
//
// Output: extension/icons/icon{16,32,48,128}.png

import path from 'node:path';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'extension', 'icons');
// Same design also drives the web app's favicon so the browser-tab
// icon and the chrome-extension icon read as the same product. Vite
// auto-copies anything in `public/` into `dist/` at the same path.
const OUT_FAVICON = path.join(REPO_ROOT, 'public', 'favicon.svg');

const SIZES = [16, 32, 48, 128];

// Brand colors — keep in sync with the Chess Coach Tailwind palette.
// `bg` is the dark surface (matches the body class in index.html);
// `glyph` is the off-white text colour.
const COLOR_BG = [30, 36, 47, 255]; // #1e242f
const COLOR_GLYPH = [230, 232, 235, 255]; // #e6e8eb

/**
 * Stylised knight silhouette on a 16×16 grid. 1 = glyph, 0 = bg.
 * Designed by hand to read clearly at 16px and stay crisp at 128px
 * via integer-scale nearest-neighbour upscaling. The shape outlines
 * a knight head facing right: ear → forehead → muzzle → chin →
 * collar.
 */
const KNIGHT_16 = [
  '0000000000000000',
  '0000000000000000',
  '0000000110000000',
  '0000001111000000',
  '0000011111110000',
  '0000111111111000',
  '0001111111111100',
  '0001110011111100',
  '0001000011111100',
  '0000000111111100',
  '0000001111111100',
  '0000011111111000',
  '0000011111110000',
  '0000111111110000',
  '0001111111111000',
  '0000000000000000',
];

// ── PNG encoding ───────────────────────────────────────────────────

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = makeCrcTable());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    crc = (crc >>> 8) ^ table[c];
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeCrcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Encode an RGBA pixel buffer as a PNG.
 * @param {Buffer} pixels  width*height*4 RGBA bytes, row-major
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function encodePNG(pixels, width, height) {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR: width, height, bit depth=8, color type=6 (RGBA), no compression options.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // IDAT: scanlines prefixed with filter byte 0 (None), zlib-compressed.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Drawing ────────────────────────────────────────────────────────

/**
 * Render an icon at the given size by:
 *   1. Filling the canvas with the bg colour.
 *   2. Applying a rounded-corner mask at radius = size/8 so the
 *      square reads as "app icon" rather than "screenshot".
 *   3. Stamping the knight glyph from KNIGHT_16, integer-scaled to
 *      fit (gives crisp pixels rather than blurry interpolation).
 */
function renderIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const radius = Math.max(2, Math.round(size / 8));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = isInsideRoundedRect(x, y, size, size, radius);
      const i = (y * size + x) * 4;
      if (!inside) {
        px[i] = 0;
        px[i + 1] = 0;
        px[i + 2] = 0;
        px[i + 3] = 0; // fully transparent corner
      } else {
        px[i] = COLOR_BG[0];
        px[i + 1] = COLOR_BG[1];
        px[i + 2] = COLOR_BG[2];
        px[i + 3] = COLOR_BG[3];
      }
    }
  }

  // Stamp the knight. We use nearest-neighbour scaling: each grid
  // cell maps to a contiguous square block of pixels. For sizes
  // smaller than 16 we'd need a downscaled glyph — but the smallest
  // size we ship is 16, so the simplest mapping (cell == 1px at
  // size=16) works.
  const cell = size / 16;
  for (let gy = 0; gy < 16; gy++) {
    for (let gx = 0; gx < 16; gx++) {
      if (KNIGHT_16[gy][gx] !== '1') continue;
      const x0 = Math.round(gx * cell);
      const x1 = Math.round((gx + 1) * cell);
      const y0 = Math.round(gy * cell);
      const y1 = Math.round((gy + 1) * cell);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (!isInsideRoundedRect(x, y, size, size, radius)) continue;
          const i = (y * size + x) * 4;
          px[i] = COLOR_GLYPH[0];
          px[i + 1] = COLOR_GLYPH[1];
          px[i + 2] = COLOR_GLYPH[2];
          px[i + 3] = COLOR_GLYPH[3];
        }
      }
    }
  }
  return encodePNG(px, size, size);
}

/**
 * Return true if (x, y) lies inside an axis-aligned `w × h` rect
 * with rounded corners of radius `r`. Used both for the bg fill and
 * to clip the glyph so corners stay transparent.
 */
function isInsideRoundedRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  // Center of each corner's quarter-circle. Outside the corner box
  // (i.e. on a straight edge), every point is inside.
  const inLeft = x < r;
  const inRight = x >= w - r;
  const inTop = y < r;
  const inBottom = y >= h - r;
  if (!(inLeft || inRight) || !(inTop || inBottom)) return true;
  const cx = inLeft ? r - 0.5 : w - r - 0.5;
  const cy = inTop ? r - 0.5 : h - r - 0.5;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Render the same KNIGHT_16 design as a vector SVG. Geometry:
 *   - viewBox is 16×16, one unit per grid cell, so the glyph cells
 *     line up to integer pixels at favicon sizes (16/32/48/64) and
 *     stay crisp without anti-alias smudging.
 *   - Rounded-rect radius is 2 viewbox units (= size/8 at any
 *     rendered pixel size), matching the PNG renderer's
 *     `radius = max(2, size/8)` rule.
 *   - The glyph is a single `<path>` of unit squares, clipped to
 *     the background rounded rect via a `<clipPath>` so the same
 *     "glyph is masked at the corners" behaviour as the PNG.
 *
 * Why colour-channel `[r, g, b, a]` arrays here: they're the same
 * tuples the PNG renderer uses; we just translate to CSS hex.
 */
function rgbaToHex([r, g, b]) {
  const h = (n) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function renderFaviconSvg() {
  const bg = rgbaToHex(COLOR_BG);
  const fg = rgbaToHex(COLOR_GLYPH);
  // Build a single path from all "1" cells: M x y h1 v1 h-1 z per
  // cell. One path is smaller and faster for the renderer than 100+
  // individual <rect>s.
  const cmds = [];
  for (let gy = 0; gy < 16; gy++) {
    for (let gx = 0; gx < 16; gx++) {
      if (KNIGHT_16[gy][gx] !== '1') continue;
      cmds.push(`M${gx} ${gy}h1v1h-1z`);
    }
  }
  const glyphPath = cmds.join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">`,
    `<clipPath id="r"><rect width="16" height="16" rx="2" ry="2"/></clipPath>`,
    `<rect width="16" height="16" rx="2" ry="2" fill="${bg}"/>`,
    `<path d="${glyphPath}" fill="${fg}" clip-path="url(#r)"/>`,
    `</svg>`,
  ].join('') + '\n';
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    const buf = renderIcon(size);
    const out = path.join(OUT_DIR, `icon${size}.png`);
    await fs.writeFile(out, buf);
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${path.relative(REPO_ROOT, out)} (${buf.length} bytes)`);
  }
  // Single source of truth: the same KNIGHT_16 grid drives the web
  // app's favicon. Anyone updating the silhouette only edits one
  // file and re-runs `node scripts/build-extension-icons.mjs`
  // (or `npm run extension:build`, which calls it first).
  await fs.mkdir(path.dirname(OUT_FAVICON), { recursive: true });
  const svg = renderFaviconSvg();
  await fs.writeFile(OUT_FAVICON, svg);
  // eslint-disable-next-line no-console
  console.log(
    `  ✓ ${path.relative(REPO_ROOT, OUT_FAVICON)} (${Buffer.byteLength(svg)} bytes)`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
