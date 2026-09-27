---
recorded: 2026-08-20T20:17:22Z
commit: 73a4517122
---
# "Positive" is only half of what DER asks of an INTEGER — it must also be minimal

Found 2026-08-21 while chasing a ~4% flake in
`apps/kortix-sandbox-agent-server/src/egress-shim/shim.test.ts`, which turned
out to be a latent production defect in the egress shim's certificate authority
(`egress-shim/ca.ts`).

The serial number was built as `'00' + randomBytes(16)`, with a comment
explaining the leading zero: a first byte `>= 0x80` is read as two's-complement
NEGATIVE and the certificate is rejected. That is true, and it is not
sufficient. **DER requires an INTEGER to be minimal as well as correctly
signed: a `0x00` prefix is legal only when the byte after it is `>= 0x80`.**
When the first random byte came in below that, the zero was redundant and the
certificate was malformed — `BoringSSL … ASN.1 … INVALID_INTEGER` on the
handshake, and `openssl x509` unable to load the file at all.

It fired once in ~256 — the odds of `randomBytes()[0] === 0x00`, the case where
even node-forge's own normalization leaves a redundant zero behind. Every
sandbox mints its own CA and a leaf per terminated host, so roughly one sandbox
in 256 got an egress CA no client could parse, and every HTTPS call the agent
made through the shim failed.

**Rules.**
1. When hand-encoding an ASN.1 INTEGER, satisfy BOTH rules or neither is
   satisfied. Clamping a random leading byte into `0x01..0x7f` answers both by
   construction — never `>= 0x80` so no prefix is needed, never `0x00` so no
   prefix is redundant — at a cost of one bit out of 128.
2. **A 1-in-256 fault sampled probabilistically is a test that passes while the
   bug ships.** Export the encoding rule and pin it directly over the whole
   `0x00..0xff` leading-byte range. The bug survived a suite that minted a
   certificate on every run for months.
3. Filler bytes in a fixture can hide the fault. `00 00 ab …` is VALID (forge
   re-adds a zero `0xab` genuinely needs); `00 00 16 …` is not. Build the
   regression case from the bytes actually captured off the failure, not from a
   convenient repeated byte.
4. `tls.createSecureContext({ cert })` is lenient where `{ ca }` is strict — a
   probe that only passes `cert` will report a malformed certificate as fine.
   Diagnose with `openssl asn1parse`, which names the offending field
   (`prim: INTEGER :BAD INTEGER:[…]`) instead of failing the whole parse.
5. Treat a flaky test in a security-path suite as a defect report until proven
   otherwise. This one was dismissible as "TLS socket timing" for as long as
   nobody read the error text.

*Incident:* no outage reported — the defect was found through CI flake, not
through a customer. Roughly 0.4% of sandboxes would have had non-functional
agent egress with no diagnostic pointing at the CA.
