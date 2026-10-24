// Renders merch.html to print files. Run from the repo root:
//   node .agents/skills/kortix-brand/references/merch/export.mjs
// Writes upload/ (the files a shop takes) and output/merch/ (every card, PNG + SVG).
// Needs Google Chrome and the Roobert fonts installed locally.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const upload = path.join(here, 'upload');
const full = path.resolve(here, '../../../../../output/merch');
for (const dir of [upload, `${full}/png`, `${full}/svg`]) fs.mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
await page.goto(`file://${path.join(here, 'merch.html')}#export`);
await page.evaluate(() => document.fonts.ready);

async function shot(svg, file, size, clip, scale = 1) {
  await page.setViewportSize(size);
  await page.evaluate(([s, w, h]) => {
    const stage = document.getElementById('stage');
    stage.style.width = `${w}px`; stage.style.height = `${h}px`;
    stage.innerHTML = s;
    stage.firstChild.style.width = `${w}px`; stage.firstChild.style.height = `${h}px`;
  }, [svg, size.width, size.height]);
  await page.evaluate(() => document.fonts.ready);
  const buf = await page.screenshot({ clip, scale: scale === 1 ? 'css' : 'device' });
  fs.writeFileSync(file, buf);
}

// Every card at 300 dpi with 1/8 in bleed (825 x 1125 px).
const card = { width: 825, height: 1125 };
const cards = await page.evaluate(() => window.CARDS);
for (const c of cards) {
  fs.writeFileSync(`${full}/svg/${c.id}.svg`, c.svg);
  await shot(c.svg, `${full}/png/${c.id}.png`, card, { x: 0, y: 0, ...card });
}

// Card backs at 600 dpi: trimmed (2.5 x 3.5 in) and with bleed.
const hd = await browser.newPage({ viewport: card, deviceScaleFactor: 2 });
await hd.goto(`file://${path.join(here, 'merch.html')}#export`);
for (const [id, name] of [['00-back', 'card-back'], ['00-back-white', 'card-back-white']]) {
  const svg = cards.find((c) => c.id === id).svg;
  await hd.evaluate((s) => { document.getElementById('stage').innerHTML = s; }, svg);
  await hd.screenshot({ path: `${upload}/${name}.png`, clip: { x: 37.5, y: 37.5, width: 750, height: 1050 } });
  await hd.screenshot({ path: `${upload}/${name}-with-bleed.png`, clip: { x: 0, y: 0, ...card } });
}

// Chip inlays: 1200 px squares, round print area.
const chip = { width: 1200, height: 1200 };
for (const c of await page.evaluate(() => window.CHIPS)) {
  fs.writeFileSync(`${full}/svg/${c.id}.svg`, c.svg);
  await shot(c.svg, `${upload}/${c.id}.png`, chip, { x: 0, y: 0, ...chip });
}

// Flags, posters, mugs, mats, totes, tees, stickers: drawn in mm, rendered at each item's px per mm.
const items = await page.evaluate(() => window.ITEMS);
for (const it of items) {
  fs.writeFileSync(`${full}/svg/${it.id}.svg`, it.svg);
  // Exact pixel size: the SVG viewBox (mm) scales to fill a 1:1 viewport.
  const pw = Math.round(it.w * it.ppm), ph = Math.round(it.h * it.ppm);
  const ip = await browser.newPage({ viewport: { width: pw, height: ph } });
  await ip.goto(`file://${path.join(here, 'merch.html')}#export`);
  await ip.evaluate(([s, w, h]) => {
    document.body.style.background = 'transparent';
    const stage = document.getElementById('stage');
    stage.style.width = `${w}px`; stage.style.height = `${h}px`;
    stage.innerHTML = s;
    stage.firstChild.style.width = `${w}px`; stage.firstChild.style.height = `${h}px`;
  }, [it.svg, pw, ph]);
  await ip.evaluate(() => document.fonts.ready);
  await ip.screenshot({ path: `${upload}/${it.id}.png`, clip: { x: 0, y: 0, width: pw, height: ph }, omitBackground: it.transparent });
  await ip.close();
}

await browser.close();
console.log(`${cards.length} cards, ${items.length} items -> ${full}\nupload files -> ${upload}`);
