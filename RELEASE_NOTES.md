Fix session-page reconnect storm against stopped sandboxes

Stops the infinite refresh/reconnect storm on the session page when a sandbox is stopped. A stopped box answers /kortix/health with 503; the frontend misread that as connected+booting and fast-polled every 150ms forever, which re-fired all health-gated file/SSE queries (walls of /global/event 503s, auth0 CORS redirects, /file/content?path=.opencode 400s). Now the 503 boot window is bounded (120s -> mark unreachable, 5s poll), and .opencode/.kortix/.git are never read as file content.
