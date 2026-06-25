/**
 * Fixture for the icon migration codemod (the "BEFORE" state).
 *
 * Demonstrates every import shape the codemod must handle:
 *  - a multi-name lucide value import (curated + normalized + direct match)
 *  - an aliased lucide import (local name must be preserved)
 *  - a lucide type-only import (`LucideIcon`)
 *  - the runtime `lucide-react/dynamic` import
 *  - react-icons value imports (brand + fill variants)
 *  - the `react-icons/lib` `IconType` prop-type import
 *
 * Running `bun scripts/migrate-icons-to-mynaui.ts` rewrites this file in place
 * to import the equivalent mynaui Solid icons. NOT a `bun test` file (no
 * `.test.` infix), so it is never executed as a suite.
 */
import { Settings, Trash2, MoreHorizontal, Calendar, KeyRound } from 'lucide-react';
import { Settings as SettingsAlias } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DynamicIcon } from 'lucide-react/dynamic';
import { SiGithub } from 'react-icons/si';
import { HiMiniSparkles } from 'react-icons/hi2';
import { IconType } from 'react-icons/lib';

export const iconRef: LucideIcon = Settings;
export const typedRef: IconType = SiGithub as unknown as IconType;

export function IconShowcase() {
  return (
    <div>
      <Settings />
      <Trash2 />
      <MoreHorizontal />
      <Calendar />
      <KeyRound />
      <SettingsAlias />
      <SiGithub />
      <HiMiniSparkles />
      <DynamicIcon name="message-circle" />
    </div>
  );
}
