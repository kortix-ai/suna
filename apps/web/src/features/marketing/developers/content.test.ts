import { describe, expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import deMessages from '../../../../translations/de.json';
import { hero, localizedDevelopersCopy, thesis } from './content';

const tDe = createTranslator({
  locale: 'de',
  messages: deMessages,
  namespace: 'hardcodedUi.i18nComplete',
});

describe('/developers copy', () => {
  const de = localizedDevelopersCopy(tDe as never);

  test('renders in the visitor language', () => {
    expect(de.hero.headline.ink).toBe('Deine KI-Belegschaft als Code.');
    expect(de.closing.title).toBe('Fragen und Antworten.');
    expect(de.cli.groups[0].label).toBe('Aufsetzen und ausliefern');
  });

  test('keeps code, commands and file contents verbatim', () => {
    expect(de.hero.fileTabs[0].code).toBe(hero.fileTabs[0].code);
    expect(de.cli.groups[0].cmds[0][0]).toBe('kortix init');
    expect(de.thesis.statements[1].diff).toEqual(thesis.statements[1].diff);
    expect(de.hero.agentInstruction).toContain('`kortix system-skills`');
  });
});
