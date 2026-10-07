import * as P from '../rest/projects-client';
import type { DropFirst } from './binding-types';
export function connectorDataPlane(projectId?: string) {
  return {
    /** Callable catalog for this project or token scope. */
    catalog: (options?: Parameters<typeof P.getConnectorCatalog>[1]) =>
      P.getConnectorCatalog(projectId, options),
    /** Flattened `<connector>.<action>` tool list. */
    tools: () => P.listConnectorTools(projectId),
    /** Search callable tools by id and description. */
    search: (...a: DropFirst<Parameters<typeof P.searchConnectorTools>>) =>
      P.searchConnectorTools(projectId, ...a),
    /** Describe one `<connector>.<action>` tool. */
    describe: (...a: DropFirst<Parameters<typeof P.describeConnectorTool>>) =>
      P.describeConnectorTool(projectId, ...a),
    /** Call one `<connector>.<action>` tool. */
    call: <T = unknown>(...a: DropFirst<Parameters<typeof P.callConnector<T>>>) =>
      P.callConnector<T>(projectId, ...a),
    /**
     * `call` with args and `output` typed by the {@link P.ConnectorArgs} /
     * {@link P.ConnectorResult} registry that `kortix connectors types` generates.
     * Same request and result as `call(\`${slug}.${action}\`, args, options)`.
     */
    callAction: <S extends string, A extends string>(
      slug: S,
      action: A,
      args: P.ConnectorArgs<S, A>,
      options?: P.ConnectorCallOptions,
    ) =>
      P.callConnector<unknown>(projectId, `${slug}.${action}`, args, options) as Promise<
        P.ConnectorCallResult<unknown, P.ConnectorResult<S, A>>
      >,
    /** The accounts a connector can be called as, default first. */
    accounts: (...a: DropFirst<Parameters<typeof P.listConnectorAccounts>>) =>
      P.listConnectorAccounts(projectId, ...a),
    /** Upload bytes for use by a later connector call. */
    uploadAttachment: (...a: DropFirst<Parameters<typeof P.uploadConnectorAttachment>>) =>
      P.uploadConnectorAttachment(projectId, ...a),
  };
}
