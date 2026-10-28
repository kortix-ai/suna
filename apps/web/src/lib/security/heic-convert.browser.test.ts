import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { enforcedContentSecurityPolicy } from './content-security-policy';

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [
      import.meta.dir + '/../../../../../packages/ui/src/internal/lib/utils/heic-convert.ts',
    ],
    target: 'browser',
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, 'HEIC browser bundle failed');
  const script = await bundle.outputs[0].text();
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/converter.js')
        return new Response(script, { headers: { 'Content-Type': 'text/javascript' } });
      if (path === '/colors.heic')
        return new Response(Bun.file(import.meta.dir + '/fixtures/colors.heic'));
      return new Response(
        '<script type="module">import { convertHeicBlobToJpeg } from "/converter.js"; window.convertHeicBlobToJpeg = convertHeicBlobToJpeg;</script>',
        {
          headers: {
            'Content-Type': 'text/html',
            'Content-Security-Policy': enforcedContentSecurityPolicy(),
          },
        },
      );
    },
  });
  browser = await chromium.launch({
    headless: true,
    executablePath: Bun.which('chromium') ?? undefined,
    args: ['--no-sandbox'],
  });
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

test('converts HEIC to a decoded JPEG under the production CSP without eval errors', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.url.href);
  const result = await Promise.race([
    page.evaluate(async () => {
      const converter = Reflect.get(window, 'convertHeicBlobToJpeg');
      const input = await (await fetch('/colors.heic')).blob();
      const jpeg = await converter(input);
      const image = await createImageBitmap(jpeg);
      const result = { type: jpeg.type, size: jpeg.size, width: image.width, height: image.height };
      image.close();
      return result;
    }),
    page.waitForEvent('pageerror').then((error) => {
      throw error;
    }),
  ]);
  expect(result.type).toBe('image/jpeg');
  expect(result.size).toBeGreaterThan(0);
  expect(result.width).toBeGreaterThan(0);
  expect(result.height).toBeGreaterThan(0);
  const repeated = await page.evaluate(async () => {
    const converter = Reflect.get(window, 'convertHeicBlobToJpeg');
    const input = await (await fetch('/colors.heic')).blob();
    const images = await Promise.all([converter(input), converter(input)]);
    let rejectedInvalid = false;
    try {
      await converter(new Blob(['not a HEIC image']));
    } catch {
      rejectedInvalid = true;
    }
    return { types: images.map((image: Blob) => image.type), rejectedInvalid };
  });
  expect(repeated.types).toEqual(['image/jpeg', 'image/jpeg']);
  expect(repeated.rejectedInvalid).toBe(true);
  expect(errors).toEqual([]);
  await page.close();
}, 15000);
