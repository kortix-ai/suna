/**
 * A connector's accounts and who may use each one. The rules live in
 * `@kortix/sdk` (`core/connectors/connector-accounts`), which the TUI's
 * `/connectors` screen reads too; these are the names the web has always
 * imported.
 */
export {
  connectorAccountNeedsSignIn as accountNeedsSignIn,
  connectorAccountVisibility as accountVisibility,
  connectorAudienceVisibility as audienceVisibility,
  connectorConnectionRows,
  newConnectorAccountAudienceFor as newAccountAudienceFor,
  newConnectorAccountGrantees as newAccountGrantees,
  newConnectorAccountLabelTaken as newAccountLabelTaken,
  newConnectorAccountReady as newAccountReady,
  type ConnectorAccountVisibility as AccountVisibility,
  type NewConnectorAccountAudience as NewAccountAudience,
  type NewConnectorAccountDraft as NewAccountDraft,
} from '@kortix/sdk';
