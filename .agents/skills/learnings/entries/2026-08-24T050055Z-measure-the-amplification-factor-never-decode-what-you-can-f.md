---
recorded: 2026-08-24T05:00:55Z
commit: 0727e9aa42
---
# Measure the amplification factor; never decode what you can forward

2026-08-24. The gateway's ai-sdk transport decoded every `data:` image with
`atob(raw).split('').map(c => c.charCodeAt(0))` — one JavaScript string per
byte, 89 MB resident for a 6.7 MB image — and then let provider-utils re-encode
the bytes through a `String.fromCodePoint` concat loop. The admission budget
charged 3x per wire byte on the assumption that the parsed graph was the only
copy. Both `@ai-sdk/anthropic` and `@ai-sdk/amazon-bedrock` accept a base64
STRING and serialize it through the identity `convertToBase64`.

**The rule.** A passthrough forwards bytes in the encoding it received them.
Before charging a memory budget, measure the real peak with a mounted request
through the real handler and write the number next to the constant
(`memory-envelope.test.ts`: 2.25x openai-compat, 2.9x anthropic, 0.61x steady
state on 2026-08-24). A budget factor without a measurement is a wish.

**Bound the inputs a client can grow without limit.** A screenshot-per-step
agent re-sends every screenshot on every turn. Providers already cap images
per request (Bedrock Converse: 20). The gateway keeps the newest 12 of >20 and
replaces older ones with a one-line notice, with hysteresis so the prefix
stays cache-stable for 8 turns.

*Incident:* SampleCo 2026-08-22, 40-screenshot / 28 MB request, cgroup OOM.
Enforcement: `memory-envelope.test.ts` (peak factor < 6x, all 40 images
forwarded byte-for-byte on both routes), `image-window.test.ts`.
