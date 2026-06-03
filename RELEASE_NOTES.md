Single-leader background workers, contact/demo flow, and build + env fixes

### New
- Contact page **demo lead qualifier** with a paid-gated founder concierge flow.
- Rebuilt **/developers** page — brand-aligned and closer to the product.
- Revived the **admin accounts console** backend.

### Improved
- Background workers (cron, triggers, sweeps) now **elect a single leader** across multi-replica Fargate, so scheduled work fires exactly once instead of once per replica.
- Maintenance flags moved to the **database** (dropped Vercel Edge Config).
- Local/dev/prod environment flow **standardized on dotenvx**, with pre-commit auto-encryption of committable `.env` files.

### Fixed
- Vercel production build (a lint error that failed `next build`).
- Vercel pnpm install falling back to npm.
- An OpenTelemetry dependency pin that was crashing `next dev`.

### Internal
- Added the **ke2e** black-box end-to-end API test suite (work in progress).
- Compliance/Drata key handling.
