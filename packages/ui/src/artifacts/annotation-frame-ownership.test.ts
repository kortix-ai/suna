import { expect, test } from 'bun:test';
import { Window as HappyWindow } from 'happy-dom';
import { connectArtifactAnnotationFrame } from '../../../../apps/web/src/features/artifacts/artifact-annotation-channel';

test('a same-size pooled frame return resets the prior owner before accepting pin clicks', async () => {
  const page = new HappyWindow({ url: 'https://app.example.test' });
  const a = page.document.createElement('div');
  const b = page.document.createElement('div');
  const frame = page.document.createElement('iframe');
  Object.defineProperty(frame, 'contentWindow', { value: { postMessage() {} } });
  page.document.body.append(a, b);
  a.append(frame);
  let resets = 0;
  let received = 0;
  const connection = connectArtifactAnnotationFrame(
    frame as unknown as HTMLIFrameElement,
    a as unknown as HTMLElement,
    {
      onLoad: () => resets++,
      onMessage: () => received++,
    },
    page as unknown as Window,
  );
  try {
    const baseline = resets;
    b.append(frame);
    await page.happyDOM.waitUntilComplete();
    expect(resets).toBeGreaterThan(baseline);
    const message = () =>
      page.dispatchEvent(
        new page.MessageEvent('message', {
          source: frame.contentWindow as never,
          data: { kortix: 'annotate', v: 1, type: 'focus', n: 1 },
        }),
      );
    message();
    expect(received).toBe(0);
    const away = resets;
    a.append(frame);
    await page.happyDOM.waitUntilComplete();
    expect(resets).toBeGreaterThan(away);
    expect(resets).toBeGreaterThan(baseline);
    expect(frame.contentWindow).not.toBeNull();
    const probe = new page.MessageEvent('message', {
      source: frame.contentWindow as never,
      data: { kortix: 'annotate', v: 1, type: 'focus', n: 1 },
    });
    expect(probe.source === frame.contentWindow).toBe(true);
    message();
    expect(received).toBe(1);
    const restored = resets;
    b.append(frame);
    a.append(frame);
    await page.happyDOM.waitUntilComplete();
    expect(resets).toBeGreaterThan(restored);
    connection.dispose();
    b.append(frame);
    a.append(frame);
    await page.happyDOM.waitUntilComplete();
    message();
    expect(received).toBe(1);
  } finally {
    connection.dispose();
    await page.happyDOM.close();
  }
});
