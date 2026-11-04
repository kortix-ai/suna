import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NATIVE_MARK_APPS, nativeMarkFileSvg } from './connector-mark-files';

/**
 * The URL the API catalogue sends for a Kortix-built connector
 * (`/connector-icons/<app>.svg`) and the in-app `ConnectorLogo` are one image:
 * the file is the component rendered. Regenerate with
 * `bun packages/ui/scripts/write-connector-marks.tsx`.
 */
describe('Kortix connector mark files', () => {
  for (const app of NATIVE_MARK_APPS) {
    test(`${app}.svg is its ConnectorLogo mark`, () => {
      const file = readFileSync(
        join(import.meta.dir, '../../../../../apps/web/public/connector-icons', `${app}.svg`),
        'utf8',
      );
      expect(file).toBe(nativeMarkFileSvg(app));
    });
  }
});
