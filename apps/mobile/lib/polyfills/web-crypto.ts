/**
 * Web Crypto for Hermes. The engine has no `crypto` global, and `@kortix/sdk`
 * assumes it: wire message ids draw their tail from `crypto.getRandomValues`
 * (sdk #8648), attachments mint ids with `crypto.randomUUID`. Without it, the
 * first-prompt seed threw "Property 'crypto' doesn't exist" while a thread
 * opened, and a home send landed back on project home. `expo-crypto` is the
 * native CSPRNG. Imported first by `app/_layout.tsx`, before any SDK call.
 */
import { getRandomValues, randomUUID } from 'expo-crypto';

const host = globalThis as { crypto?: Partial<Crypto> };
host.crypto ??= {};
host.crypto.getRandomValues ??= getRandomValues as Crypto['getRandomValues'];
host.crypto.randomUUID ??= randomUUID as Crypto['randomUUID'];
