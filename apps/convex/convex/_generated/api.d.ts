/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as a2a from "../a2a.js";
import type * as admin from "../admin.js";
import type * as agents from "../agents.js";
import type * as contexts from "../contexts.js";
import type * as conversations from "../conversations.js";
import type * as facts from "../facts.js";
import type * as governance from "../governance.js";
import type * as graphSync from "../graphSync.js";
import type * as immutable from "../immutable.js";
import type * as memories from "../memories.js";
import type * as memorySpaces from "../memorySpaces.js";
import type * as mutable from "../mutable.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  a2a: typeof a2a;
  admin: typeof admin;
  agents: typeof agents;
  contexts: typeof contexts;
  conversations: typeof conversations;
  facts: typeof facts;
  governance: typeof governance;
  graphSync: typeof graphSync;
  immutable: typeof immutable;
  memories: typeof memories;
  memorySpaces: typeof memorySpaces;
  mutable: typeof mutable;
  users: typeof users;
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

export declare const components: {};
