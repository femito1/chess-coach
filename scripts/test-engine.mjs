// Drives a real Chromium via Playwright, loads our dev server, instantiates
// the Stockfish Web Worker through our engine module, and reports success/failure.

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5174/';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const logs = [];
page.on('console', (msg) => {
  logs.push(`[${msg.type()}] ${msg.text()}`);
});
page.on('pageerror', (err) => {
  logs.push(`[pageerror] ${err.message}\n${err.stack}`);
});
page.on('requestfailed', (req) => {
  logs.push(`[requestfailed] ${req.url()} :: ${req.failure()?.errorText}`);
});

console.log(`→ Loading ${URL}`);
await page.goto(URL, { waitUntil: 'domcontentloaded' });

// Sanity: COI flag
const coi = await page.evaluate(() => ({
  crossOriginIsolated: self.crossOriginIsolated,
  hasSAB: typeof SharedArrayBuffer !== 'undefined',
  ua: navigator.userAgent,
}));
console.log('crossOriginIsolated =', coi.crossOriginIsolated, 'SAB =', coi.hasSAB);

// Probe both builds directly and capture first error/message.
async function probe(file) {
  return await page.evaluate(async (file) => {
    return await new Promise((resolve) => {
      const messages = [];
      let settled = false;
      const url = `/stockfish/${file}`;
      let w;
      try {
        w = new Worker(url);
      } catch (e) {
        resolve({ file, error: `constructor threw: ${e.message}` });
        return;
      }
      w.addEventListener('message', (ev) => {
        messages.push(String(ev.data));
        if (!settled && String(ev.data).includes('uciok')) {
          settled = true;
          w.postMessage('isready');
        }
        if (String(ev.data) === 'readyok' && settled) {
          setTimeout(() => {
            w.terminate();
            resolve({ file, ok: true, messages: messages.slice(0, 50) });
          }, 100);
        }
      });
      w.addEventListener('error', (e) => {
        if (settled) return;
        settled = true;
        resolve({
          file,
          error: e.message || 'unknown',
          filename: e.filename,
          lineno: e.lineno,
          messages: messages.slice(0, 50),
        });
      });
      w.addEventListener('messageerror', () => {
        if (settled) return;
        settled = true;
        resolve({ file, error: 'messageerror', messages: messages.slice(0, 50) });
      });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({
          file,
          error: `timeout after 15s (received ${messages.length} messages)`,
          messages: messages.slice(0, 50),
        });
      }, 15000);
      // Kick off UCI handshake.
      w.postMessage('uci');
    });
  }, file);
}

for (const file of ['stockfish-nnue-16.js', 'stockfish-nnue-16-single.js']) {
  console.log(`\n--- Probing ${file} ---`);
  const result = await probe(file);
  console.log(JSON.stringify(result, null, 2));
}

console.log('\n--- Browser console logs ---');
for (const l of logs) console.log(l);

await browser.close();
