Signed-in previews open again

### Fixed

- **Previews open again when you are signed in.** A sandbox preview opened from a session (`prod-p<port>-sbx-….p.kortix.com`) showed "Sign in to open this preview" even though you were signed in. Sign-in tokens are still issued with the older HS256 signature while the published key set already holds the newer ES256 key. The API already verified those tokens with the auth server, but the preview gate refused them. It now makes the same check, so the preview panel, pasted preview links, and preview WebSockets open for the account that owns the sandbox. A forged or expired token is still refused, and a test now fails if any verifier caller handles these results in its own way.

### Internal

- The release gate quarantines TUN-6 on deployed targets only: Bun's WebSocket client sends no User-Agent, so the edge firewall refuses the tunnel handshake on staging and prod. The flow still runs locally.
