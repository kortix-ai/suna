import { Hono } from 'hono';

import { projectsApp } from '../projects';
import type { AppEnv } from '../types';
import { workspaceResponseCompatibility } from './compat';

/**
 * Canonical Workspace facade over the Project-backed implementation.
 *
 * Physical database and compatibility route names remain Project during the
 * namespace expansion. This facade keeps one implementation while returning
 * canonical Workspace wire keys from `/v1/workspaces`.
 */
export const workspacesApp = new Hono<AppEnv>();

workspacesApp.use('*', workspaceResponseCompatibility);
workspacesApp.route('/', projectsApp);
