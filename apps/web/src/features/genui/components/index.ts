import type { GenuiComponentMap } from '../sdk';
import { GenuiCompare, GenuiRankedList, GenuiStat, GenuiStatRow, GenuiTable } from './data';
import { GenuiBadge, GenuiCallout, GenuiImage, GenuiLink } from './inline';
import { GenuiAccordion, GenuiCard, GenuiStack, GenuiTabs } from './layout';

export { GenuiPending } from './pending';

export const webGenuiComponents: GenuiComponentMap = {
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
