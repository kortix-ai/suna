import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { UiProvider } from '../providers/ui-provider';
import { defaultUiMessages, useLocale, useTranslations, type UiUseTranslations } from './index';

function Probe({ ns, run }: { ns: string; run: (t: ReturnType<UiUseTranslations>) => string }) {
  const t = useTranslations(ns);
  return <span>{`${useLocale()}|${run(t)}`}</span>;
}

const html = (node: React.ReactNode) => renderToStaticMarkup(node).replace(/<\/?span>/g, '');

describe('@kortix/ui/i18n without a host', () => {
  test('translates from the bundled English catalog, with ICU values and plurals', () => {
    expect(html(<Probe ns="threads" run={(t) => t('stoppedBy', { name: 'Ada' })} />)).toBe('en|Stopped by Ada');
    expect(html(<Probe ns="threads" run={(t) => t('queuedFiles', { count: 2 })} />)).toBe('en|2 files');
  });

  test('renders agent audiences from bundled English without host translations', () => {
    expect(html(<Probe ns="secrets" run={(t) => t('agentAccess', { agents: 'audit-agent' })} />)).toBe('en|Agents: audit-agent');
    expect(html(<Probe ns="secrets" run={(t) => t('agentAccess', { agents: t('allAgents') })} />)).toBe('en|Agents: All agents');
    expect(html(<Probe ns="secrets" run={(t) => t('agentAccess', { agents: t('noAgents') })} />)).toBe('en|Agents: No agents');
  });

  test('t.raw and t.has read the catalog; a missing key renders `namespace.key`', () => {
    expect(html(<Probe ns="threads" run={(t) => String(t.raw('stoppedBy'))} />)).toBe('en|Stopped by {name}');
    expect(html(<Probe ns="threads" run={(t) => `${t.has('stoppedBy')},${t.has('noSuchKey')}`} />)).toBe('en|true,false');
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      expect(html(<Probe ns="threads" run={(t) => t('noSuchKey')} />)).toBe('en|threads.noSuchKey');
    } finally {
      console.error = original;
    }
    expect(errors.length).toBeGreaterThan(0);
  });

  test('`locale` + `messages` replace the bundled catalog', () => {
    const i18n = { locale: 'de', messages: { threads: { stoppedBy: 'Gestoppt von {name}' } } };
    expect(
      html(
        <UiProvider i18n={i18n}>
          <Probe ns="threads" run={(t) => t('stoppedBy', { name: 'Ada' })} />
        </UiProvider>,
      ),
    ).toBe('de|Gestoppt von Ada');
  });
});

describe('@kortix/ui/i18n with host hooks', () => {
  test('calls the host hooks with the namespace', () => {
    const seen: (string | undefined)[] = [];
    const useHostTranslations = ((ns?: string) => {
      seen.push(ns);
      return (key: string) => `host:${ns}.${key}`;
    }) as unknown as UiUseTranslations;
    const i18n = { useTranslations: useHostTranslations, useLocale: () => 'fr' };
    expect(
      html(
        <UiProvider i18n={i18n}>
          <Probe ns="threads" run={(t) => t('stoppedBy')} />
        </UiProvider>,
      ),
    ).toBe('fr|host:threads.stoppedBy');
    expect(seen).toEqual(['threads']);
  });
});

test('en.ts matches its sources (run: pnpm --filter @kortix/ui gen-i18n-catalog)', () => {
  const script = fileURLToPath(new URL('../../scripts/gen-i18n-catalog.mjs', import.meta.url));
  const run = spawnSync('node', [script, '--check'], { encoding: 'utf8' });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
});

test('every hardcodedUi.i18nComplete key held in data in a scanned file is in the catalog', async () => {
  const { HEX_KEY, scannedFiles } = await import('../../scripts/gen-i18n-catalog.mjs');
  const web = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../apps/web/translations/en.json', import.meta.url)), 'utf8'));
  const source: Record<string, string> = web.hardcodedUi.i18nComplete;
  const bundled: Record<string, string> = defaultUiMessages.hardcodedUi.i18nComplete;
  const missing = scannedFiles().flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(HEX_KEY)]
      .map((m) => m[2])
      .filter((key) => key in source && !(key in bundled))
      .map((key) => `${file}: ${key}`),
  );
  expect(missing).toEqual([]);
});
