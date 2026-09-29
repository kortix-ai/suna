import { authorize } from '../../iam';
import { actorOf } from '../../iam/actor';
import { PROJECT_ACTIONS } from '../../iam/actions';

export async function canDo(
  c: any,
  projectId: string,
  accountId: string,
  action: string,
): Promise<boolean> {
  const verdict = await authorize(await actorOf(c, accountId), action, {
    type: 'project',
    id: projectId,
  });
  return verdict.allowed;
}

export const canSetBudget = (c: any, projectId: string, accountId: string) =>
  canDo(c, projectId, accountId, PROJECT_ACTIONS.PROJECT_GATEWAY_BUDGET_SET);
export const canManageKeys = (c: any, projectId: string, accountId: string) =>
  canDo(c, projectId, accountId, PROJECT_ACTIONS.PROJECT_GATEWAY_KEYS_MANAGE);
