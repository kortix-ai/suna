Hotfix gateway Unicode trace logging

Promote the staging hotfix that strips NUL bytes before persisting gateway request/response traces to gateway_request_logs, preventing Postgres 22P05 unsupported Unicode escape sequence alerts from recurring in production.
