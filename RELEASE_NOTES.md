Static-token auth for webhook triggers

Webhook triggers now also accept a static shared token (X-Kortix-Token / Authorization Bearer or Basic) when no HMAC signature is present, so alert sources that can't sign their body (e.g. Better Stack error webhooks) can fire triggers. HMAC stays primary; signed senders unaffected.
