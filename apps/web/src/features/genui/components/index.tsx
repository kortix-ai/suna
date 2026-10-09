import { lazy, Suspense } from 'react';

import type { GenuiComponentMap, GenuiComponentProps } from '../sdk';
import { GenuiCompare, GenuiRankedList, GenuiStat, GenuiStatRow, GenuiTable } from './data';
import { GenuiBadge, GenuiCallout, GenuiImage, GenuiLink } from './inline';
import { GenuiAccordion, GenuiCard, GenuiStack, GenuiTabs } from './layout';
import { GenuiPending } from './pending';

export { GenuiPending };

// recharts loads with the first chart, not with every reply. The fallback holds the chart's 220px.
const LazyChart = lazy(() => import('./charts'));
function GenuiChart(props: GenuiComponentProps) {
  return (
    <Suspense fallback={GenuiPending(props.node)}>
      <LazyChart {...props} />
    </Suspense>
  );
}

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
  BarChart: GenuiChart,
  LineChart: GenuiChart,
  PieChart: GenuiChart,
  Badge: GenuiBadge,
  Callout: GenuiCallout,
  Image: GenuiImage,
  Link: GenuiLink,
};
