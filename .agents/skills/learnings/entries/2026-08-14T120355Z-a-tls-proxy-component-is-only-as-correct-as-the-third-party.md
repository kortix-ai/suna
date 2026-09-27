---
recorded: 2026-08-14T12:03:55Z
incident_date: 2026-08-14
commit: 55b03fe2ca
---
# A TLS/proxy component is only as correct as the third-party clients that accept it

**When:** shipping anything that terminates TLS, mints certificates, or sits in
front of other people's HTTP clients (the in-guest egress shim, any MITM proxy).
Unit tests and a `curl` probe are NOT evidence. Three separate bugs in this one
component passed every in-process test and every curl check, and each was found
only by running a real heterogeneous client in a real guest:

- `git` sends CONNECT, gets a 407, and retries **on the same socket**. Without
  `Content-Length: 0` + `Connection: close` on the challenge the retry vanishes
  and every clone fails, while curl is unaffected because it reconnects.
- Python's OpenSSL refuses a chain whose leaf carries no **Authority Key
  Identifier** (`CERTIFICATE_VERIFY_FAILED ... Missing Authority Key
  Identifier`); curl accepts the identical certificate. An AKI also needs a
  **Subject Key Identifier** on the issuer to point at, and node-forge's PARSED
  `subjectKeyIdentifier` is a hex string — feeding it back yields an AKI naming
  an issuer that does not exist and breaks every handshake. Use
  `caCert.generateSubjectKeyIdentifier().getBytes()`.
- `curl` offers `Accept-Encoding: gzip` by default. Any redaction that scans
  response BYTES is silently defeated by a compressed body, so a credential
  echoed back returns intact. Force `identity` on the relayed request.

Run the real clients — `curl`, `python3 -m requests`, `git`, `node fetch` — in a
real sandbox before claiming a proxy works, and assert on what the UPSTREAM
received, not on the absence of an error.
*Incident:* the Daytona network-boundary shim shipped to dev broken for every
Python client; caught by a live probe, not by 27 green tests.
