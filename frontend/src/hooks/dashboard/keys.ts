const dashboardKeysBase = ['dashboard'] as const;
const dashboardAgentsBase = ['dashboard', 'agents'] as const;

export const dashboardKeys = {
  all: dashboardKeysBase,
  agents: dashboardAgentsBase,
  limits: () => [...dashboardKeysBase, 'limits'] as const,
  initiateAgent: () => [...dashboardAgentsBase, 'initiate'] as const,
} as const;
