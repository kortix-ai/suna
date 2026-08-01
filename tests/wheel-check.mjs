import { chromium } from '/Users/markokraemer/Projects/kortix/suna-comms-revamp/node_modules/.pnpm/@playwright+test@1.61.1/node_modules/@playwright/test/index.mjs';

const OUT =
  '/private/tmp/claude-501/-Users-markokraemer-Projects-kortix-suna/3bec9333-b597-47c4-be52-f0b692c56665/scratchpad';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto('http://localhost:15100/', { waitUntil: 'load', timeout: 120000 });
await page.addStyleTag({ content: 'nextjs-portal,[data-nextjs-toast]{display:none!important}' });
await page.waitForSelector('#use-cases', { timeout: 60000 });
await page.waitForTimeout(1500);

const track = await page.evaluate(() => {
  const section = document.querySelector('#use-cases');
  const t = section.firstElementChild;
  const r = t.getBoundingClientRect();
  return { top: r.top + window.scrollY, height: t.offsetHeight, vh: window.innerHeight };
});
console.log('track', JSON.stringify(track));

const span = track.height - track.vh;
const depths = [0.02, 0.25, 0.5, 0.75, 0.98];
const results = [];

for (let i = 0; i < depths.length; i += 1) {
  const y = Math.round(track.top + span * depths[i]);
  await page.evaluate((v) => window.scrollTo(0, v), y);
  await page.waitForTimeout(700);

  const state = await page.evaluate(() => {
    const stage = document.querySelector('#use-cases [data-active-index]');
    const cards = [...document.querySelectorAll('#use-cases [data-use-case]')];
    const measured = cards.map((c) => {
      const r = c.getBoundingClientRect();
      return {
        id: c.dataset.useCase,
        active: c.dataset.active,
        w: Math.round(r.width),
        cx: Math.round(r.left + r.width / 2),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        op: Number(getComputedStyle(c).opacity).toFixed(2),
      };
    });
    const mid = window.innerWidth / 2;
    const opaque = measured.filter((m) => Number(m.op) > 0.9);
    const nearest = opaque.reduce((a, b) =>
      Math.abs(b.cx - mid) < Math.abs(a.cx - mid) ? b : a,
    );
    const upright = cards
      .map((c) => {
        const m = new DOMMatrixReadOnly(getComputedStyle(c).transform);
        return { id: c.dataset.useCase, deg: Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI) };
      })
      .reduce((a, b) => (Math.abs(b.deg) < Math.abs(a.deg) ? b : a));
    const widest = measured.reduce((a, b) => (b.w > a.w ? b : a));
    const visible = measured.filter((m) => Number(m.op) > 0.02).length;
    const header = document.querySelector('#use-case-wheel-title').getBoundingClientRect();
    const sub = header.bottom;
    const minCardTop = Math.min(...measured.filter((m) => Number(m.op) > 0.02).map((m) => m.top));
    return {
      activeIndex: stage.dataset.activeIndex,
      activeCard: measured.find((m) => m.active === 'true')?.id,
      nearestCentre: `${nearest.id}@${nearest.cx}`,
      mostUpright: `${upright.id}@${upright.deg}deg`,
      widestCard: widest.id,
      widestW: widest.w,
      visible,
      headerBottom: Math.round(sub),
      minCardTop,
      docScrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      stickyTop: Math.round(
        document.querySelector('#use-cases .sticky').getBoundingClientRect().top,
      ),
    };
  });
  results.push({ depth: depths[i], y, ...state });
  console.log(`depth ${depths[i]}`, JSON.stringify(state));

  await page.screenshot({
    path: `${OUT}/wheel-${i + 1}.png`,
    animations: 'disabled',
    timeout: 30000,
  });
}

const centres = results.map((r) => r.activeCard);
console.log('\nACTIVE CARD PER DEPTH:  ', centres.join(' -> '));
console.log('NEAREST-CENTRE PER DEPTH:', results.map((r) => r.nearestCentre).join(' -> '));
console.log('MOST-UPRIGHT PER DEPTH:  ', results.map((r) => r.mostUpright).join(' -> '));
console.log('VISIBLE CARDS PER DEPTH: ', results.map((r) => r.visible).join(' '));
console.log('UNIQUE ACTIVE:', new Set(centres).size, 'of', centres.length);
console.log(
  'H-SCROLL:',
  results.map((r) => `${r.docScrollW}/${r.clientW}`).join(' '),
);

// reduced-motion fallback
const rmPage = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  reducedMotion: 'reduce',
});
await rmPage.goto('http://localhost:15100/', { waitUntil: 'load', timeout: 120000 });
await rmPage.addStyleTag({ content: 'nextjs-portal,[data-nextjs-toast]{display:none!important}' });
await rmPage.waitForTimeout(2500);
const rm = await rmPage.evaluate(() => {
  const cards = [...document.querySelectorAll('#use-cases [data-use-case]')];
  const grid = document.querySelectorAll('#use-cases article').length;
  const transforms = [...document.querySelectorAll('#use-cases article')].map(
    (c) => getComputedStyle(c).transform,
  );
  return {
    wheelCards: cards.length,
    articles: grid,
    transforms: [...new Set(transforms)],
    hasTrack: !!document.querySelector('#use-cases > div[style*="vh"]'),
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  };
});
console.log('REDUCED MOTION:', JSON.stringify(rm));
await rmPage.evaluate(() => {
  const s = document.querySelector('#use-cases');
  window.scrollTo(0, s.getBoundingClientRect().top + window.scrollY - 40);
});
await rmPage.waitForTimeout(600);
await rmPage.screenshot({ path: `${OUT}/wheel-reduced.png`, animations: 'disabled', fullPage: false });

await browser.close();
