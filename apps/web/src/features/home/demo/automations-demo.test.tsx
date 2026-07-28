import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
}));

import { describeCron } from '@/features/workspace/automations/cron';

import { AutomationsDemo } from './automations-demo';
import { DEMO_AUTOMATIONS, WEBHOOK_CADENCE } from './demo-automations-data';

const SOURCE = readFileSync(
  fileURLToPath(new URL('./automations-demo.tsx', import.meta.url)),
  'utf8',
);

const html = renderToStaticMarkup(<AutomationsDemo />);

describe('content', () => {
  test('renders every automation by its manifest name', () => {
    expect(DEMO_AUTOMATIONS.length).toBeGreaterThan(0);
    for (const automation of DEMO_AUTOMATIONS) {
      expect(html).toContain(automation.name);
    }
  });

  test('is the real screen: same title and same one-line description', () => {
    expect(html).toContain('Automations');
    expect(html).toContain('Run work on a schedule, or when something happens elsewhere.');
  });

  test('keeps the All / Schedules / Webhooks filter row', () => {
    expect(html).toContain('Schedules');
    expect(html).toContain('Webhooks');
  });
});

describe('cadence is generated, not written', () => {
  test('every schedule reads exactly as describeCron renders it', () => {
    for (const automation of DEMO_AUTOMATIONS) {
      if (automation.type !== 'cron' || !automation.cron) continue;
      expect(html).toContain(describeCron(automation.cron));
    }
  });

  test('the demo covers more than one cadence shape', () => {
    const phrases = new Set(
      DEMO_AUTOMATIONS.filter((a) => a.cron).map((a) => describeCron(a.cron as string)),
    );
    expect(phrases.size).toBeGreaterThan(2);
  });

  test('no raw cron expression ever reaches the screen', () => {
    for (const automation of DEMO_AUTOMATIONS) {
      if (!automation.cron) continue;
      expect(html).not.toContain(automation.cron);
    }
    expect(html).not.toContain('* * *');
  });

  test('webhooks read the way the product reads them', () => {
    expect(html).toContain(WEBHOOK_CADENCE);
  });

  test('calls the product’s own describeCron rather than re-implementing it', () => {
    expect(SOURCE).toContain(
      "import { describeCron } from '@/features/workspace/automations/cron';",
    );
  });
});

describe('honesty', () => {
  test('invents no run history and no on/off state', () => {
    expect(html).not.toContain('last run');
    expect(html).not.toContain('Paused');
    expect(html).not.toContain('role="switch"');
  });

  test('fetches nothing — there is no session to fetch with', () => {
    expect(SOURCE).not.toContain("from '@kortix/sdk'");
    expect(SOURCE).not.toContain('useQuery');
  });
});

describe('gating', () => {
  test('every control routes to sign-in', () => {
    expect(SOURCE).toContain("const onGate = () => gate('/');");
    expect(SOURCE).toContain('onClick={onGate}');
    expect(SOURCE).toContain('onGate={onGate}');
    expect(SOURCE).toContain('search={demoSearch(');
  });

  test('exactly one h1, so the shared shell contract still holds', () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
  });
});
