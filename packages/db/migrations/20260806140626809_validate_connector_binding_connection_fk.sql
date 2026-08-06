-- Migration: validate_connector_binding_connection_fk
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.project_session_connector_bindings
  VALIDATE CONSTRAINT project_session_connector_bindings_connection_tenant_fk;

ALTER TABLE kortix.project_session_connector_bindings
  VALIDATE CONSTRAINT project_session_connector_bindings_connection_not_null;
