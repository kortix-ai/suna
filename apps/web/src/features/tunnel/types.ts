import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { PRODUCT_CATALOG_TRANSLATION_KEYS } from '@/i18n/product-catalog-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';
import {
  HardDriveIcon as HardDrive,
  MonitorIcon as Monitor,
  TerminalWindowIcon as Terminal,
  type Icon,
} from '@phosphor-icons/react';

export interface CapabilityInfo {
  key: string;
  label: string;
  description: string;
  icon: Icon;
}

/**
 * What a paired computer may be asked to do. The approval page picks a subset;
 * the local agent config stays the hard ceiling on every call.
 */
export const CAPABILITY_REGISTRY: CapabilityInfo[] = [
  {
    key: 'filesystem',
    label: 'Filesystem',
    description: 'Read, write, list, and delete local files',
    icon: HardDrive,
  },
  {
    key: 'shell',
    label: 'Shell',
    description: 'Execute commands in a local terminal',
    icon: Terminal,
  },
  {
    key: 'desktop',
    label: 'Computer Use',
    description: 'See the screen and use the apps on this computer',
    icon: Monitor,
  },
];

export function localizedCapabilityRegistry(tI18nComplete: UiTranslator): CapabilityInfo[] {
  return localizeUiCatalog(CAPABILITY_REGISTRY, tI18nComplete, PRODUCT_CATALOG_TRANSLATION_KEYS);
}
