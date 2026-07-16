Restore Kortix managed model availability

Refresh the authenticated managed-model catalog when adopting warm-fork sandboxes, restarting OpenCode only when the live catalog changes. Also preserve the staging Cloudflare Worker gateway bindings so managed inference reaches the configured gateway backend.

Verified on dev and staging with fresh real sandboxes: kortix/glm-5.2 returned exactly PONG. Staging proof used a real Stripe test-mode paid subscription and cleaned up all resources.
