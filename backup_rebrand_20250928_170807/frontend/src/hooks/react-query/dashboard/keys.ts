import { createQueryKeys } from '@/hooks/use-query';

const dashboardKeysBase = ['dashboard'] as const;
const dashboardAgentsBase = ['dashboard', 'agents'] as const;

export const dashboardKeys = createQueryKeys({
  all: dashboardKeysBase,
  agents: dashboardAgentsBase,
  initiateAgent: () => [...dashboardAgentsBase, 'initiate'] as const,
});
