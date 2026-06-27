Marketplace runtime, managed gateway defaults, and staging release hardening

## New

- Added the native Kortix marketplace runtime floor so new projects can start with curated skills, starter defaults, and marketplace install/update flows built into the project experience.
- Expanded the Marketplace UI, CLI commands, registry handling, and project creation defaults so skills can be browsed, installed, updated, and carried into starter projects consistently.
- Moved the managed LLM gateway into the default routing path behind the production master switch, with OpenRouter and Bedrock-backed managed model routing, AUTO model handling, and server-owned model configuration.
- Added no-restart warm-fork and sandbox runtime improvements, including build-time catalog baking and credential hot-swap paths for faster agent startup without restarting OpenCode.
- Added agent email channel support, Slack per-user identity controls, and improved channel/session selection behavior.

## Improved

- Hardened the dev, staging, and production release topology: staging is the release-candidate branch, production promotion retags tested staging images, prod rollback is image-aware, and staging/prod deploy workflows apply database migrations in the right environment.
- Improved staging environment correctness, including staging database isolation, staging auth/runtime configuration, Daytona as the staging sandbox provider, and staging Cloudflare/API worker deployment.
- Improved session reliability across browser, terminal, PTY, tunnel, file upload, PDF rendering, and first-prompt retry paths.
- Improved frontend onboarding and project creation flows with marketplace starter selection, first-project bootstrap fixes, chat input polish, session sidebar persistence, and model picker stability.
- Improved gateway observability and runtime behavior with structured run-path logging, managed catalog support, session cost display fixes, and live env handling for router tools.

## Fixed

- Fixed staging deploy dispatch, build, and promotion edge cases so staging image pins and release-source SHAs are preserved correctly for production retags.
- Fixed multiple auth and environment regressions in staging, including server auth env alignment and runtime config validation.
- Fixed CI and security scan issues around marketplace code, frontend build memory, Drata visibility gating, and staging QA/report publishing.
- Fixed channel and connector bugs for AgentMail, Slack, email inbox binding, profile inbox defaults, and executor call routing.
- Fixed warm snapshot and warm pool toggles so disabled settings remain disabled and stale build contexts self-heal.
