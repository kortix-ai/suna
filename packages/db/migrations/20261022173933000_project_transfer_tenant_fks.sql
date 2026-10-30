-- Keep tenant integrity immediate for normal writes; project transfer explicitly
-- defers these checks while moving both ends of the same tenant relationship.
-- mixed-version-safe: existing callers keep immediate FK checks; only the new transfer transaction defers them. No rows or keys change.
SET lock_timeout = '2s';
SET statement_timeout = '30s';

ALTER TABLE kortix.connector_connections
  ALTER CONSTRAINT connector_connections_connector_tenant_fk DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE kortix.project_session_connector_bindings
  ALTER CONSTRAINT project_session_connector_bindings_session_tenant_fk DEFERRABLE INITIALLY IMMEDIATE,
  ALTER CONSTRAINT project_session_connector_bindings_alias_tenant_fk DEFERRABLE INITIALLY IMMEDIATE,
  ALTER CONSTRAINT project_session_connector_bindings_connection_tenant_fk DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE kortix.connection_oauth_applications
  ALTER CONSTRAINT connection_oauth_applications_connection_tenant_fk DEFERRABLE INITIALLY IMMEDIATE;
