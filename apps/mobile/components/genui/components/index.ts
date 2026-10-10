import type { GenuiComponentMap } from '@kortix/sdk/genui/react';

import { GenuiAccordion } from './accordion';
import { GenuiChart } from './charts';
import { GenuiCompare, GenuiRankedList, GenuiStat, GenuiStatRow, GenuiTable } from './data';
import { GenuiBadge, GenuiCallout, GenuiImage, GenuiLink } from './inline';
import { GenuiCard, GenuiStack, GenuiTabs } from './layout';
import { GenuiMap } from './map';

export { GenuiPending } from './pending';

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
  BarChart: GenuiChart,
  LineChart: GenuiChart,
  PieChart: GenuiChart,
  Map: GenuiMap,
  Badge: GenuiBadge,
  Callout: GenuiCallout,
  Image: GenuiImage,
  Link: GenuiLink,
};
