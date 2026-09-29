import { authorize } from '../../iam';
import { actorOf } from '../../iam/actor';

// The one authorization probe the focused gateway route modules share: does the
// caller hold `action` on this project?

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
