---
recorded: 2026-10-31T17:22:22Z
incident_date: 2026-10-31
---
# Catch malformed JWT signature decoding at the verification boundary

**Rule:** Decode untrusted signature bytes inside the same error boundary as cryptographic verification.

**Trigger surface:** Local asymmetric JWT verification for API and sandbox preview authentication.

**Incident:** 2026-10-31, KRTX-3779: API dev preview requests raised InvalidCharacterError. Synthetic malformed signatures reproduce the exception before verification starts.

**Enforcement:** apps/api/src/__tests__/unit-jwt-es256-liveness.test.ts rejects malformed signature encodings without throwing or consulting liveness.
