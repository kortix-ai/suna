import type { GenuiComponentMap } from '@kortix/sdk/genui/react';

import { GenuiAccordion } from './accordion';
import { GenuiCompare, GenuiRankedList, GenuiStat, GenuiStatRow, GenuiTable } from './data';
import { GenuiBadge, GenuiCallout, GenuiImage, GenuiLink } from './inline';
import { GenuiCard, GenuiStack, GenuiTabs } from './layout';

export { GenuiPending } from './pending';

/** The charts and Map are not mapped yet: the SDK renders a missing entry as its markdown. */
export const mobileGenuiComponents: GenuiComponentMap = {
  Stack: GenuiStack,
  Card: GenuiCard,
  Tabs: GenuiTabs,
  Accordion: GenuiAccordion,
  Stat: GenuiStat,
  StatRow: GenuiStatRow,
  Table: GenuiTable,
  Compare: GenuiCompare,
  RankedList: GenuiRankedList,
  Badge: GenuiBadge,
  Callout: GenuiCallout,
  Image: GenuiImage,
  Link: GenuiLink,
};
