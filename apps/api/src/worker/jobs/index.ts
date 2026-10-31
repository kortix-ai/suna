/**
 * Every scheduled job, in start order.
 *
 * A scheduled job runs on exactly one process: the one holding the leader
 * lease (`shared/leader-election.ts`). In production that is the worker
 * service (`src/worker.ts`); the web servers run with
 * `KORTIX_PROCESS_ROLE=web` and never join the election. Self-host, local dev
 * and previews run one process with the default role `all`, which joins the
 * election and runs these jobs too. Running them on several processes would
 * fire every cron trigger once per process.
 *
 * Adding a job: put its timer and start/stop in `worker/jobs/<name>.ts`, keep
 * the tick in its domain module, wrap the tick in `runWorkerTick('<name>', …)`
 * and add it here. `unit-worker-scope-wiring.test.ts` fails on a loop that is
 * neither here nor an approved per-process loop in `replica/`.
 */
import { kickStartupPreBuild } from '../../snapshots/builder';
import type { Job } from '../runtime/job';
import { startAccountDeletionSchedule, stopAccountDeletionSchedule } from './account-deletion';
import { startActiveTurnRenewal, stopActiveTurnRenewal } from './active-turn-renewal';
import { startAppDeploymentWorker, stopAppDeploymentWorker } from './app-deployment';
import { startAppIdleReaper, stopAppIdleReaper } from './app-idle-reaper';
import { startApprovalExpirySweeper, stopApprovalExpirySweeper } from './approval-expiry';
import { startAuditActivityWorker, stopAuditActivityWorker } from './audit-activity';
import { startAuditArchiveWorker, stopAuditArchiveWorker } from './audit-archive';
import { startAuditPartitionWorker, stopAuditPartitionWorker } from './audit-partition';
import { startAuditReconciliationWorker, stopAuditReconciliationWorker } from './audit-reconciliation';
import { startAuditWebhookWorker, stopAuditWebhookWorker } from './audit-webhook';
import { startBillingRotation, stopBillingRotation } from './billing-rotation';
import { startCaptureWorkers, stopCaptureWorkers } from './capture';
import { startCaptureHealthWorker, stopCaptureHealthWorker } from './capture-health';
import { startDriveWorkers, stopDriveWorkers } from './drive';
import { startGatewaySpendBackfillWorker, stopGatewaySpendBackfillWorker } from './gateway-spend-backfill';
import { startGrantExpirySweeper, stopGrantExpirySweeper } from './grant-expiry';
import { startNotificationWorker, stopNotificationWorker } from './notification';
import { startOAuthSweeper, stopOAuthSweeper } from './oauth-sweep';
import { startProjectMaintenance, stopProjectMaintenance } from './project-maintenance';
import { startProjectSnapshotWorker, stopProjectSnapshotWorker } from './project-snapshot';
import { startProviderTransitionWorker, stopProviderTransitionWorker } from './provider-transition';
import { startResidentialProxyBillingWorker, stopResidentialProxyBillingWorker } from './residential-proxy-billing';
import { startSessionLogPurgeWorker, stopSessionLogPurgeWorker } from './session-log-purge';
import { startSessionModelFallbackWorker, stopSessionModelFallbackWorker } from './session-model-fallback';
import { startSlackTurnGc, stopSlackTurnGc } from './slack-turn-gc';
import { startTeamsTurnGc, stopTeamsTurnGc } from './teams-turn-gc';
import { startProjectTriggerScheduler, stopProjectTriggerScheduler, triggerSweepStalled } from './trigger-scheduler';
import { startTunnelCleanup, stopTunnelCleanup } from './tunnel-cleanup';
import { startTunnelForwardExpiry, stopTunnelForwardExpiry } from './tunnel-forward-expiry';

export const JOBS: readonly Job[] = [
  { ticks: ['active-turn-renewal'], start: () => startActiveTurnRenewal(), stop: stopActiveTurnRenewal },
  { ticks: ['project-maintenance'], start: startProjectMaintenance, stop: stopProjectMaintenance },
  {
    ticks: ['trigger-scheduler'],
    start: startProjectTriggerScheduler,
    stop: stopProjectTriggerScheduler,
    stalled: triggerSweepStalled,
  },
  // Mint the platform-default sandbox image once per leadership term, so the
  // first session anywhere lands on a cache hit. One shot, no timer.
  { ticks: ['startup-prebuild'], start: kickStartupPreBuild, stop: () => {} },
  // Resume durable sandbox-provider migrations a stop left mid-flight.
  { ticks: ['provider-transition'], start: startProviderTransitionWorker, stop: stopProviderTransitionWorker },
  { ticks: ['app-deployments'], start: startAppDeploymentWorker, stop: stopAppDeploymentWorker },
  { ticks: ['app-idle-reaper', 'app-keep-alive'], start: startAppIdleReaper, stop: stopAppIdleReaper },
  { ticks: ['audit-webhooks'], start: startAuditWebhookWorker, stop: stopAuditWebhookWorker },
  { ticks: ['audit-reconciliation'], start: startAuditReconciliationWorker, stop: stopAuditReconciliationWorker },
  // Weekly partitions of kortix.audit_events, 8 weeks ahead.
  { ticks: ['audit-partitions'], start: startAuditPartitionWorker, stop: stopAuditPartitionWorker },
  // The per-day account activity rollup behind GET /accounts/:id/audit/activity.
  { ticks: ['audit-activity'], start: startAuditActivityWorker, stop: stopAuditActivityWorker },
  // Weeks older than 90 days to S3 (Object Lock). Off by default.
  { ticks: ['audit-archive'], start: startAuditArchiveWorker, stop: stopAuditArchiveWorker },
  // Prebuilt project snapshot archives. Idle unless KORTIX_PROJECT_SNAPSHOT_S3_BUCKET is set.
  { ticks: ['project-snapshots'], start: startProjectSnapshotWorker, stop: stopProjectSnapshotWorker },
  {
    ticks: ['capture-index-reader', 'capture-maintenance', 'capture-events-reader'],
    start: startCaptureWorkers,
    stop: stopCaptureWorkers,
  },
  // Tells the people with capture.manage when a computer stops recording.
  { ticks: ['capture-health'], start: startCaptureHealthWorker, stop: stopCaptureHealthWorker },
  // IAM time-bounded grants: one audit event per row that just expired.
  { ticks: ['iam-grant-expiry'], start: startGrantExpirySweeper, stop: stopGrantExpirySweeper },
  // Connector approvals past expires_at. Never resumes a session.
  { ticks: ['approval-expiry'], start: startApprovalExpirySweeper, stop: stopApprovalExpirySweeper },
  { ticks: ['oauth-sweep'], start: startOAuthSweeper, stop: stopOAuthSweeper },
  {
    ticks: ['drive-conflict-scan', 'volume-deletions', 'drive-mount-revocations'],
    start: startDriveWorkers,
    stop: stopDriveWorkers,
  },
  // Trial expiry and credit rotations. Idempotent per account and month.
  {
    ticks: ['billing-trial-expiry', 'billing-yearly-rotation', 'billing-free-tier-rotation'],
    start: startBillingRotation,
    stop: stopBillingRotation,
  },
  // Close Slack/Teams live cards whose run ended without a reply.
  { ticks: ['slack-turn-gc'], start: startSlackTurnGc, stop: stopSlackTurnGc },
  { ticks: ['teams-turn-gc'], start: startTeamsTurnGc, stop: stopTeamsTurnGc },
  // Scheduled account deletions past their 14-day grace; the first tick drains the backlog.
  { ticks: ['account-deletion'], start: startAccountDeletionSchedule, stop: stopAccountDeletionSchedule },
  // The unread-row email digest and the 90-day retention sweep.
  { ticks: ['notification-digest'], start: startNotificationWorker, stop: stopNotificationWorker },
  // Retention purge of session content.
  { ticks: ['session-log-purge'], start: startSessionLogPurgeWorker, stop: stopSessionLogPurgeWorker },
  // Idle sessions off a fallback model once their own model serves again.
  { ticks: ['session-model-fallback'], start: startSessionModelFallbackWorker, stop: stopSessionModelFallbackWorker },
  // Closed pending days of the gateway spend running total.
  { ticks: ['gateway-spend-backfill'], start: startGatewaySpendBackfillWorker, stop: stopGatewaySpendBackfillWorker },
  // Residential proxy charges from Platinum's billing feed, debited once per event.
  {
    ticks: ['residential-proxy-billing'],
    start: startResidentialProxyBillingWorker,
    stop: stopResidentialProxyBillingWorker,
  },
  // Database-wide tunnel sweeps; every API process ran them before the worker split.
  { ticks: ['tunnel-cleanup'], start: startTunnelCleanup, stop: stopTunnelCleanup },
  { ticks: ['tunnel-forward-expiry'], start: startTunnelForwardExpiry, stop: stopTunnelForwardExpiry },
];
