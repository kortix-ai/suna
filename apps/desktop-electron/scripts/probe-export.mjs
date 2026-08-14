import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:17951';
const browser = await chromium.launch();
const page = await browser.newPage();
const failed = [], errors = [];
page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().replace(BASE,'')}`); });
page.on('pageerror', e => errors.push(e.message));

const target = '/projects/proj_REAL123/sessions/sess_REAL456';
await page.goto(BASE + target, { waitUntil: 'load' });
await page.waitForTimeout(4000);

const result = await page.evaluate(() => ({
  url: location.pathname,
  title: document.title,
  reactMounted: !!document.querySelector('#__next, body > div'),
  bodyTextLen: document.body.innerText.length,
  runtimeConfig: window.__KORTIX_RUNTIME_CONFIG ? Object.keys(window.__KORTIX_RUNTIME_CONFIG) : null,
  backendUrl: window.__KORTIX_RUNTIME_CONFIG?.BACKEND_URL ?? null,
  shellLeak: document.body.innerHTML.includes('__shell__'),
}));
console.log(JSON.stringify(result, null, 2));
console.log('HTTP >=400:', failed.length ? failed.slice(0,10) : 'none');
console.log('page errors:', errors.length ? errors.slice(0,5) : 'none');
await browser.close();
