import { afterEach, describe, expect, test } from 'bun:test';
import { config } from '../config';
import { skillsApp } from '../skills';

const previous = config.KORTIX_CHROME_ENABLED;
afterEach(() => {
  config.KORTIX_CHROME_ENABLED = previous;
});

const names = async () => ((await (await skillsApp.request('/')).json()) as { skills: { name: string }[] }).skills.map((s) => s.name);

describe('Kortix system skills behind a flag the platform does not offer', () => {
  test('KORTIX_CHROME_ENABLED off (staging, prod): kortix-chrome is not listed or served', async () => {
    config.KORTIX_CHROME_ENABLED = false;
    const listed = await names();
    expect(listed).not.toContain('kortix-chrome');
    expect(listed).toContain('kortix-system');
    expect((await skillsApp.request('/kortix-chrome')).status).toBe(404);
    expect((await skillsApp.request('/kortix-chrome/file?path=SKILL.md')).status).toBe(404);
  });

  test('KORTIX_CHROME_ENABLED on (dev): kortix-chrome is listed and served', async () => {
    config.KORTIX_CHROME_ENABLED = true;
    expect(await names()).toContain('kortix-chrome');
    const res = await skillsApp.request('/kortix-chrome');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { featureFlag: string }).featureFlag).toBe('chrome');
  });
});
