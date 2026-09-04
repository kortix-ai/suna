// THE MODEL — injectable, because the interesting part of this system is not the
// model and a test that needs an API key is a test that does not run in CI.
//
// pi's Agent takes a `streamFn`. Anything that returns an AssistantMessageEventStream
// is a model, so:
//
//   scriptedStream  a fixed sequence of turns. Deterministic, offline, free —
//                   and it exercises the ENTIRE machinery that is actually ours:
//                   the tool call, the daemon round trip, the op ledger, the
//                   SQLite persistence, the resume.
//   anthropicStream a real model, used when ANTHROPIC_API_KEY is present.
//
// The scripted one is the default on purpose. What we are proving here is that a
// durable agent loop runs inside a V8 isolate with no filesystem; whether a real
// model chooses a good command is a different question with a different bill.
export { scriptedStream } from "./scripted.js";

/**
 * A REAL MODEL. Which providers are compiled in is a BUILD CHOICE, not code:
 * the bare specifier "agent-providers" is aliased by build.mjs to
 * providers.slim.js (the default) or providers.all.js, from `model.providers`
 * in agent.config.json.
 *
 * The first version of this file hand-rolled an Anthropic client over fetch, on
 * the assumption that pi-ai's providers pull node builtins the way
 * pi-coding-agent does. That assumption was wrong and worth checking: 10 of
 * pi-ai's 11 streaming APIs bundle for a worker target with ZERO unresolved
 * imports (only bedrock-converse-stream fails, on the AWS SDK), and so does the
 * whole 40-provider catalogue.
 *
 * So no provider code lives here at all — pi's own records carry `streamSimple`.
 */
// A BARE specifier, not a relative path: esbuild's `alias` only rewrites bare
// names, and the whole point is that build.mjs swaps this for providers.slim.js
// or providers.all.js. There is no package by this name — resolution is the
// alias, so a build without it fails loudly instead of silently picking one.
export { listProviders as supportedProviders } from "agent-providers";
import { lookupModel, streamFor } from "agent-providers";

export const resolveModel = (cfg) => lookupModel(cfg);
export const providerStream = (provider) => streamFor(provider);
