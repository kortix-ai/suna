import * as P from '../rest/projects-client';

export function bindProjectPlatformResources(projectId: string) {
  return {
    gateway: {
      logs: (opts?: Parameters<typeof P.listGatewayLogs>[1]) => P.listGatewayLogs(projectId, opts),
      log: (logId: string) => P.getGatewayLog(projectId, logId),
      overview: (days?: number) => P.getGatewayOverview(projectId, days),
      series: (days?: number) => P.getGatewaySeries(projectId, days),
      breakdown: (days?: number) => P.getGatewayBreakdown(projectId, days),
      sessions: (days?: number) => P.getGatewaySessions(projectId, days),
      errors: (days?: number) => P.getGatewayErrors(projectId, days),
      budgets: () => P.getGatewayBudgets(projectId),
      setBudget: (input: Parameters<typeof P.setGatewayBudget>[1]) =>
        P.setGatewayBudget(projectId, input),
      deleteBudget: (budgetId: string) => P.deleteGatewayBudget(projectId, budgetId),
      keys: () => P.getGatewayKeys(projectId),
      createKey: (name: string) => P.createGatewayKey(projectId, name),
      revokeKey: (keyId: string) => P.revokeGatewayKey(projectId, keyId),
      routing: {
        get: () => P.getGatewayRoutingPolicy(projectId),
        set: (policy: Parameters<typeof P.setGatewayRoutingPolicy>[1]) =>
          P.setGatewayRoutingPolicy(projectId, policy),
        reset: () => P.resetGatewayRoutingPolicy(projectId),
        preview: (input: Parameters<typeof P.previewGatewayRoute>[1]) =>
          P.previewGatewayRoute(projectId, input),
      },
      /** Run one prompt against up to 6 models side by side (a model-comparison playground). */
      playground: (prompt: string, models: string[], system?: string) =>
        P.runGatewayPlayground(projectId, prompt, models, system),
    },

    /** Slack + email + Meet channel connections. */
  };
}
