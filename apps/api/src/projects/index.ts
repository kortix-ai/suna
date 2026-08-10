/**
 * @deprecated Legacy Project namespace adapter.
 *
 * New code imports `../workspaces`. This module exists only for `/v1/projects`
 * and published Project-named server integrations.
 */
import { Hono } from 'hono';

import type { AppEnv } from '../types';
import {
  buildSessionSandboxEnvVars,
  commitManifest,
  continueSession,
  createWorkspaceSession,
  createSession,
  drainSessionLifecycleQueue,
  drainTriggerExecutionQueue,
  getTriggerSchedulerHealth,
  loadManifestForEdit,
  resolveGitTriggerActor,
  resolveWorkspaceAutomationActor,
  runWorkspaceTriggerSweep,
  schedulerSweepIsStale,
  startWorkspaceTriggerScheduler,
  startSession,
  stopWorkspaceTriggerScheduler,
  workspaceWebhooksApp,
} from '../workspaces';
import { workspaceRoutesApp } from '../workspaces/lib/app';
export {
  authorizeGitProxy,
  resolveWorkspaceUpstream,
  type GitProxyAuth,
  withWorkspaceGitAuth,
} from '../workspaces';
import { projectResponseCompatibility } from './compat';

export const projectsApp = new Hono<AppEnv>();
projectsApp.use('*', projectResponseCompatibility);
projectsApp.route('/', workspaceRoutesApp);

export const projectWebhooksApp = new Hono<AppEnv>();
projectWebhooksApp.use('/projects/*', projectResponseCompatibility);
projectWebhooksApp.route('/', workspaceWebhooksApp);

export {
  buildSessionSandboxEnvVars,
  commitManifest,
  continueSession,
  createWorkspaceSession,
  createSession,
  drainSessionLifecycleQueue,
  drainTriggerExecutionQueue,
  getTriggerSchedulerHealth,
  loadManifestForEdit,
  resolveGitTriggerActor,
  resolveWorkspaceAutomationActor,
  runWorkspaceTriggerSweep,
  schedulerSweepIsStale,
  startWorkspaceTriggerScheduler,
  startSession,
  stopWorkspaceTriggerScheduler,
};
