/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as audit from "../audit.js";
import type * as auth from "../auth.js";
import type * as billing from "../billing.js";
import type * as citations from "../citations.js";
import type * as documents from "../documents.js";
import type * as engine from "../engine.js";
import type * as firms from "../firms.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as kit from "../kit.js";
import type * as kitInstall from "../kitInstall.js";
import type * as kortix from "../kortix.js";
import type * as lib_cite from "../lib/cite.js";
import type * as lib_segment from "../lib/segment.js";
import type * as lumenAgent from "../lumenAgent.js";
import type * as matters from "../matters.js";
import type * as memberTokens from "../memberTokens.js";
import type * as members from "../members.js";
import type * as operator from "../operator.js";
import type * as runs from "../runs.js";
import type * as seats from "../seats.js";
import type * as seed from "../seed.js";
import type * as tags from "../tags.js";
import type * as threads from "../threads.js";
import type * as usage from "../usage.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  audit: typeof audit;
  auth: typeof auth;
  billing: typeof billing;
  citations: typeof citations;
  documents: typeof documents;
  engine: typeof engine;
  firms: typeof firms;
  http: typeof http;
  ingest: typeof ingest;
  kit: typeof kit;
  kitInstall: typeof kitInstall;
  kortix: typeof kortix;
  "lib/cite": typeof lib_cite;
  "lib/segment": typeof lib_segment;
  lumenAgent: typeof lumenAgent;
  matters: typeof matters;
  memberTokens: typeof memberTokens;
  members: typeof members;
  operator: typeof operator;
  runs: typeof runs;
  seats: typeof seats;
  seed: typeof seed;
  tags: typeof tags;
  threads: typeof threads;
  usage: typeof usage;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
};
