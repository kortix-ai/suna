Auth, billing & connector fixes

- **Auth:** magic-link sign-in no longer silently falls back to localhost for the redirect target.
- **Connectors:** the Pipedream connect popup is now usable inside the Customize modal.
- **Memory:** branded memory tool views + a fix for memory create durability.
- **Billing (dev):** self-contained Stripe test sandbox for local per-seat checkout.
- **Infra:** documented `kortix-alb-waf` `*_BODY` rules set to Count.
