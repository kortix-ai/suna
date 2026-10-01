import * as P from '../rest/projects-client';

type DropFirst<T extends unknown[]> = T extends [unknown, ...infer R] ? R : [];
export function projectConnections(projectId: string) {
  return {
    list: () => P.listConnections(projectId),
    listAll: () => P.listAllConnections(projectId),
    reconcile: (...a: DropFirst<Parameters<typeof P.reconcileConnection>>) =>
      P.reconcileConnection(projectId, ...a),
    reconcileMember: (...a: DropFirst<Parameters<typeof P.reconcileMemberConnection>>) =>
      P.reconcileMemberConnection(projectId, ...a),
    updateCredential: (...a: DropFirst<Parameters<typeof P.updateConnectionCredential>>) =>
      P.updateConnectionCredential(projectId, ...a),
    revoke: (...a: DropFirst<Parameters<typeof P.revokeConnection>>) =>
      P.revokeConnection(projectId, ...a),
    activate: (...a: DropFirst<Parameters<typeof P.activateConnection>>) =>
      P.activateConnection(projectId, ...a),
    setDefault: (...a: DropFirst<Parameters<typeof P.setDefaultConnection>>) =>
      P.setDefaultConnection(projectId, ...a),
    rename: (...a: DropFirst<Parameters<typeof P.renameConnection>>) =>
      P.renameConnection(projectId, ...a),
    share: (...a: DropFirst<Parameters<typeof P.shareConnection>>) =>
      P.shareConnection(projectId, ...a),
    /** Add a machine the caller paired to this project as a `computer` account. */
    addComputer: (...a: DropFirst<Parameters<typeof P.addComputerToProject>>) =>
      P.addComputerToProject(projectId, ...a),
    pipedreamConnect: (...a: DropFirst<Parameters<typeof P.pipedreamConnectConnection>>) =>
      P.pipedreamConnectConnection(projectId, ...a),
    pipedreamFinalize: (...a: DropFirst<Parameters<typeof P.pipedreamFinalizeConnection>>) =>
      P.pipedreamFinalizeConnection(projectId, ...a),
  };
}
