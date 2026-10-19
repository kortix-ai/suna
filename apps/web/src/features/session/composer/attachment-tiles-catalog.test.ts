import { describe, expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';

import deMessages from '../../../../translations/de.json';
import { attachmentTileCopy } from './attachment-tiles';

describe('attachment tile catalog strings', () => {
  test('renders the failure reason, retry label, and announcement in the active locale', () => {
    const translator = createTranslator({
      locale: 'de',
      messages: deMessages,
      namespace: 'hardcodedUi.composerAttachments',
    });
    const copy = attachmentTileCopy(translator);

    expect(Object.keys(copy).sort()).toEqual([
      'didNotUpload',
      'failureReason',
      'retryNamed',
      'uploadFailed',
    ]);
    expect(copy.failureReason('billing')).toBe(
      'Ihr Tarif oder Guthaben erlaubt derzeit keine Uploads.',
    );
    expect(copy.failureReason('connection')).toBe(
      'Upload fehlgeschlagen. Prüfen Sie Ihre Verbindung.',
    );
    expect(copy.uploadFailed).toBe('Upload fehlgeschlagen. Prüfen Sie Ihre Verbindung.');
    expect(copy.retryNamed('fehler.pdf')).toBe('Upload von fehler.pdf erneut versuchen');
    expect(copy.didNotUpload('fehler.pdf')).toBe('fehler.pdf wurde nicht hochgeladen.');
  });
});
