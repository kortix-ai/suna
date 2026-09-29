import { authorize } from '../../iam';
import { actorOf } from '../../iam/actor';

// The project-capability authorization probe the gateway route modules share.

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
