/**
 * The access check of the Artifact routes, shared by every route file that
 * acts on an Artifact (`routes/artifacts.ts`): a route module never imports
 * another route module.
 *
 * Per route, for the caller's role AND an agent's `kortix_permissions` grant:
 *   read    project.artifact.read
 *   write   project.artifact.write
 * On top, per Artifact: view needs `canView`; `write` needs write access to
 * its path in Files; `manage` needs its creator or project.artifact.manage.
 * A private Artifact the caller may not view answers 404, never 403.
 */
import type { Context } from 'hono';
import { PROJECT_ACTIONS } from '../../iam';
import { agentMayPerform, assertAgentScope, getAgentGrant } from '../../iam/agent-scope';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { privateChannelFoldersFor, sessionPrivateChannelFolder } from '../../drives/service';
import { driveStorageAvailable } from '../../drives/volumes';
import { canManage, canView, getArtifact, mayWrite, type Viewer } from '../../artifacts/service';
import { assertProjectCapability, loadProjectForUser, projectCapabilityAllowed } from './access';

/**
 * Load the project and assert the read or write leaf. Artifacts are paths in
 * Files: a Kortix that stores no Drive answers 403 `feature_disabled`.
 */
export async function authorizeArtifactCaller(c: Context, projectId: string, mode: 'read' | 'write') {
  // Loaded for read: the leaves below are the gate ('session' would assert
  // project.session.start, which artifacts do not use).
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { ok: false as const, response: c.json({ error: 'Not found' }, 404) };
  if (!driveStorageAvailable()) {
    return { ok: false as const, response: c.json({ error: 'Artifacts live in the Drive, and this Kortix stores no Drive.', code: 'feature_disabled', feature: 'artifacts' }, 403) };
  }
  const can = async (leaf: string) => agentMayPerform(getAgentGrant(c), leaf) && projectCapabilityAllowed(c, loaded.userId, loaded.row.accountId, projectId, leaf);
  const action = mode === 'read' ? PROJECT_ACTIONS.PROJECT_ARTIFACT_READ : PROJECT_ACTIONS.PROJECT_ARTIFACT_WRITE;
  assertAgentScope(c, action);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, action);
  const [projectWrite, manageAny] = await Promise.all([can(PROJECT_ACTIONS.PROJECT_WRITE), can(PROJECT_ACTIONS.PROJECT_ARTIFACT_MANAGE)]);
  // A private channel's files: only its members, and a session token only from its own thread (the one Drive rule).
  const bound = callerKortixSessionId(c);
  const [folders, channelFolder] = await Promise.all([
    privateChannelFoldersFor(projectId, loaded.userId as string, bound),
    bound ? sessionPrivateChannelFolder(bound) : Promise.resolve(null),
  ]);
  const viewer: Viewer = {
    userId: loaded.userId as string,
    projectWrite,
    manageAny,
    privateFolders: folders.visible,
    allPrivateFolders: folders.all,
    channelFolder,
  };
  return { ok: true as const, loaded, viewer, can };
}

/**
 * The Artifact the caller may view (404 otherwise). `write` also needs write
 * access to its path in Files; `manage` needs the creator or project.artifact.manage.
 */
export async function loadArtifactForCaller(
  c: Context,
  projectId: string,
  artifactId: string,
  mode: 'read' | 'pin' | 'write' | 'manage',
) {
  const access = await authorizeArtifactCaller(c, projectId, mode === 'read' || mode === 'pin' ? 'read' : 'write');
  if (!access.ok) return access;
  const row = await getArtifact(projectId, artifactId);
  if (!row || !canView(row, access.viewer)) return { ok: false as const, response: c.json({ error: 'Artifact not found' }, 404) };
  if (mode === 'manage' && !canManage(row, access.viewer)) {
    return { ok: false as const, response: c.json({ error: 'Only its creator or a workspace manager can change how this artifact is shared', code: 'artifact_read_only' }, 403) };
  }
  if (mode === 'write' && !(await mayWrite(row, access.viewer))) {
    return { ok: false as const, response: c.json({ error: 'You can only view this artifact: its files are not writable for you in Files', code: 'artifact_read_only' }, 403) };
  }
  return { ...access, row };
}
