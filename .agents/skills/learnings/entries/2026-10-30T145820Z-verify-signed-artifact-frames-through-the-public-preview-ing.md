---
recorded: 2026-10-30T14:58:20Z
incident_date: 2026-10-30
---
# Verify signed Artifact frames through the public preview ingress

**Rule:** Open signed HTML through the public preview ingress in a real browser. HTTP 200 and a valid origin CSP do not prove the browser can frame it. Keep the Artifact sandbox. Use a separate content origin when an ingress framing policy excludes the application.

**Trigger surface:** HTML Artifact previews, injected annotation bridges, and preview content-origin configuration.

**Incident:** PR #11196 passed origin HTTP checks, but Platinum ingress appended a console-only `frame-ancestors` policy. Chromium blocked both ordinary and annotated HTML. An owned content-only listener and HTTPS tunnel verified the existing dedicated-content-origin configuration. No provider or shared ingress changed. Route and method denial checks passed; the API configuration and temporary resources were restored after verification.

**Enforcement:** Required manual Chromium verification creates text, point, and region comments, reloads three saved pins, verifies frame ownership checks, and observes zero HTML writes. Automation gap: add this journey to the deployed browser lane after the preview platform provisions a compatible content origin automatically.
