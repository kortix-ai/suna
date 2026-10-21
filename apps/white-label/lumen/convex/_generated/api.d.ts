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
import type * as crons from "../crons.js";
import type * as customWorkflows from "../customWorkflows.js";
import type * as deployment from "../deployment.js";
import type * as documents from "../documents.js";
import type * as engine from "../engine.js";
import type * as firms from "../firms.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as kortix from "../kortix.js";
import type * as lib_cite from "../lib/cite.js";
import type * as lib_columns from "../lib/columns.js";
import type * as lib_segment from "../lib/segment.js";
import type * as lib_template from "../lib/template.js";
import type * as library from "../library.js";
import type * as lumenAgent from "../lumenAgent.js";
import type * as marketing from "../marketing.js";
import type * as matters from "../matters.js";
import type * as members from "../members.js";
import type * as operator from "../operator.js";
import type * as reviews from "../reviews.js";
import type * as runs from "../runs.js";
import type * as seats from "../seats.js";
import type * as seed from "../seed.js";
import type * as tags from "../tags.js";
import type * as threads from "../threads.js";
import type * as usage from "../usage.js";
import type * as workflows from "../workflows.js";

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
  crons: typeof crons;
  customWorkflows: typeof customWorkflows;
  deployment: typeof deployment;
  documents: typeof documents;
  engine: typeof engine;
  firms: typeof firms;
  http: typeof http;
  ingest: typeof ingest;
  kortix: typeof kortix;
  "lib/cite": typeof lib_cite;
  "lib/columns": typeof lib_columns;
  "lib/segment": typeof lib_segment;
  "lib/template": typeof lib_template;
  library: typeof library;
  lumenAgent: typeof lumenAgent;
  marketing: typeof marketing;
  matters: typeof matters;
  members: typeof members;
  operator: typeof operator;
  reviews: typeof reviews;
  runs: typeof runs;
  seats: typeof seats;
  seed: typeof seed;
  tags: typeof tags;
  threads: typeof threads;
  usage: typeof usage;
  workflows: typeof workflows;
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
