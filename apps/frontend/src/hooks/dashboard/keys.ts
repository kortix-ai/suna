const dashboardKeysBase = ['dashboard'] as const;
const dashboardAgentsBase = ['dashboard', 'agents'] as const;

export const dashboardKeys = {
  all: dashboardKeysBase,
  agents: dashboardAgentsBase,
  initiateAgent: () => [...dashboardAgentsBase, 'initiate'] as const,
} as const;
