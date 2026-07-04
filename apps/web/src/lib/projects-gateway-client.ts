// Thin re-export — the gateway observability client now lives in the SDK
// (packages/sdk/src/platform/projects-client/gateway.ts). Kept here under the
// original names so the many consumers under features/workspace/customize
// don't need to change their import paths.

export {
  listGatewayLogs,
  getGatewayLog,
  getGatewayOverview,
  getGatewaySeries,
  getGatewayBreakdown,
  getGatewaySessions,
  getGatewayErrors,
  getGatewayBudgets,
  setGatewayBudget,
  deleteGatewayBudget,
  getGatewayKeys,
  createGatewayKey,
  revokeGatewayKey,
  type GatewayLogRow,
  type GatewayLogDetail,
  type GatewayLogsResponse,
  type GatewayOverview,
  type GatewaySeriesPoint,
  type GatewayErrorStat,
  type GatewayErrorsResponse,
  type GatewaySeries,
  type GatewayModelStat,
  type GatewayBreakdown,
  type GatewaySessionStat,
  type GatewaySessions,
  type GatewayBudgetRow,
  type GatewayMemberSpend,
  type GatewayBudgetsResponse,
  type SetGatewayBudgetInput,
  type GatewayKeyRow,
  type CreatedGatewayKey,
} from '@kortix/sdk/projects-client';
