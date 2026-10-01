import * as P from '../rest/projects-client';
import { bindProjectOperationsAdmin } from './project-operations-admin';

import type { projectConnections } from './project-connections';
import { connectorDataPlane } from './project-connectors';
type DropFirst<T extends unknown[]> = T extends [unknown, ...infer R] ? R : [];
export function bindProjectOperations(
  projectId: string,
  connections: ReturnType<typeof projectConnections>,
) {
  return {
    connectors: {
      ...connectorDataPlane(projectId),
      list: () => P.listConnectors(projectId),
      config: (...a: DropFirst<Parameters<typeof P.getConnectorConfig>>) =>
        P.getConnectorConfig(projectId, ...a),
      create: (...a: DropFirst<Parameters<typeof P.createConnector>>) =>
        P.createConnector(projectId, ...a),
      remove: (...a: DropFirst<Parameters<typeof P.deleteConnector>>) =>
        P.deleteConnector(projectId, ...a),
      sync: () => P.syncConnectors(projectId),
      auth: {
        discover: (...a: DropFirst<Parameters<typeof P.discoverConnectorAuth>>) =>
          P.discoverConnectorAuth(projectId, ...a),
      },
      setName: (...a: DropFirst<Parameters<typeof P.setConnectorName>>) =>
        P.setConnectorName(projectId, ...a),
      setCredentialMode: (...a: DropFirst<Parameters<typeof P.setConnectorCredentialMode>>) =>
        P.setConnectorCredentialMode(projectId, ...a),
      setAuthorizationStrategy: (
        ...a: DropFirst<Parameters<typeof P.setConnectorAuthorizationStrategy>>
      ) => P.setConnectorAuthorizationStrategy(projectId, ...a),
      setCredential: (...a: DropFirst<Parameters<typeof P.setConnectorCredential>>) =>
        P.setConnectorCredential(projectId, ...a),
      setSensitive: (...a: DropFirst<Parameters<typeof P.setConnectorSensitive>>) =>
        P.setConnectorSensitive(projectId, ...a),
      connections,
      policies: {
        get: (...a: DropFirst<Parameters<typeof P.getConnectorPolicies>>) =>
          P.getConnectorPolicies(projectId, ...a),
        set: (...a: DropFirst<Parameters<typeof P.setConnectorPolicies>>) =>
          P.setConnectorPolicies(projectId, ...a),
      },
      /** Easy-connect (Pipedream): app catalog + connect/finalize handshake. */
      pipedream: {
        listApps: (...a: DropFirst<Parameters<typeof P.listPipedreamApps>>) =>
          P.listPipedreamApps(projectId, ...a),
        /** The browse page: a fixed top slice of each of the largest
         *  categories, with each category's true total, in one request. */
        listSections: (...a: DropFirst<Parameters<typeof P.listPipedreamSections>>) =>
          P.listPipedreamSections(projectId, ...a),
        connect: (...a: DropFirst<Parameters<typeof P.pipedreamConnect>>) =>
          P.pipedreamConnect(projectId, ...a),
        finalize: (...a: DropFirst<Parameters<typeof P.pipedreamFinalize>>) =>
          P.pipedreamFinalize(projectId, ...a),
      },
      /** Direct connector catalogue and normalized domain surfaces. */
      discover: {
        list: (...a: DropFirst<Parameters<typeof P.listDiscoverConnectors>>) =>
          P.listDiscoverConnectors(projectId, ...a),
        /** The browse page: Popular plus a fixed top slice of each section,
         *  with each section's true total, in one request. */
        sections: (...a: DropFirst<Parameters<typeof P.listDiscoverSections>>) =>
          P.listDiscoverSections(projectId, ...a),
        detail: (...a: DropFirst<Parameters<typeof P.getDiscoverConnector>>) =>
          P.getDiscoverConnector(projectId, ...a),
      },
    },

    ...bindProjectOperationsAdmin(projectId),
  };
}
