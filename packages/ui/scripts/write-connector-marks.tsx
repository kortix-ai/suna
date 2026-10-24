/**
 * Writes `apps/web/public/connector-icons/<app>.svg` for the Kortix-built
 * connectors from their `ConnectorLogo` marks. Run after changing a mark:
 *   bun packages/ui/scripts/write-connector-marks.tsx
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NATIVE_MARK_APPS, nativeMarkFileSvg } from '../src/internal/connector-logo/connector-mark-files';

const dir = join(import.meta.dir, '../../../apps/web/public/connector-icons');
for (const app of NATIVE_MARK_APPS) writeFileSync(join(dir, `${app}.svg`), nativeMarkFileSvg(app));
console.log(`wrote ${NATIVE_MARK_APPS.length} marks to ${dir}`);
