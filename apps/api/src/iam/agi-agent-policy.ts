import type { AgentGrant } from '@kortix/db';
import { AGI_AGENT_NAME } from '@kortix/shared';
import { PROJECT_ACTIONS } from './actions';

/**
 * Server-owned action grant for the reserved AGI coordinator.
 *
 * The database copy on a session token is a cache. Authorization must use this
 * canonical policy so a stale token cannot remove required coordinator actions
 * or restore actions that the platform denies.
 */
export const PLATFORM_AGI_AGENT_ACTIONS = [
  PROJECT_ACTIONS.PROJECT_READ,
  PROJECT_ACTIONS.PROJECT_GOAL_READ,
  PROJECT_ACTIONS.PROJECT_GOAL_WRITE,
  PROJECT_ACTIONS.PROJECT_TASK_READ,
  PROJECT_ACTIONS.PROJECT_TASK_WRITE,
  PROJECT_ACTIONS.PROJECT_CR_OPEN,
  PROJECT_ACTIONS.PROJECT_SESSION_READ,
  PROJECT_ACTIONS.PROJECT_SESSION_START,
  PROJECT_ACTIONS.PROJECT_FILE_READ,
  PROJECT_ACTIONS.PROJECT_GITOPS_READ,
] as const;

export function platformAgiAgentGrant(): AgentGrant {
  return {
    agent: AGI_AGENT_NAME,
    kortixCli: [...PLATFORM_AGI_AGENT_ACTIONS],
    connectors: [],
    env: [],
  };
}
