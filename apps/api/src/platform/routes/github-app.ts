import { makeOpenApiApp } from '../../openapi';
import type { AppEnv } from '../../types';
import { managedGithubRouter } from './managed-github';

export const githubAppSetupRouter = makeOpenApiApp<AppEnv>();
githubAppSetupRouter.route('/', managedGithubRouter);
