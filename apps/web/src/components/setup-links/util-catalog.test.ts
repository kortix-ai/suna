import { describe, expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';

import en from '../../../translations/en.json';
import sr from '../../../translations/sr.json';

describe('secretIntakeWithheld catalog strings', () => {
  // Render the real catalog entries the form uses, so a broken ICU plural
  // fails here rather than on the form after a person saved a value.
  const t = createTranslator({ locale: 'en', messages: en, namespace: 'hardcodedUi' });

  test('title and grant fix name the agent and the Customize path', () => {
    expect(t('secretIntakeWithheld.title', { agent: 'analyst' })).toBe(
      "Saved, but analyst can't read it yet",
    );
    expect(
      t('secretIntakeWithheld.grant', { names: 'A_KEY', count: 1, agent: 'analyst' }),
    ).toBe(
      "A_KEY is not in the analyst agent's secrets. Open Customize → Agents → analyst → Secrets and enable it.",
    );
  });

  test('plurals agree with the number of names', () => {
    expect(
      t('secretIntakeWithheld.grant', { names: 'A_KEY, B_KEY', count: 2, agent: 'analyst' }),
    ).toContain('A_KEY, B_KEY are not in the analyst agent');
    expect(t('secretIntakeWithheld.allowlist', { names: 'C_KEY', count: 1 })).toBe(
      "C_KEY is outside this session's secrets. Start a new session to use it.",
    );
    const tsr = createTranslator({ locale: 'sr', messages: sr, namespace: 'hardcodedUi' });
    expect(
      tsr('secretIntakeWithheld.grant', { names: 'A_KEY, B_KEY', count: 2, agent: 'analyst' }),
    ).toContain('нису');
  });
});
