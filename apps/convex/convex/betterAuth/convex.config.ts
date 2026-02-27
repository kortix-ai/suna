/**
 * Kortix Suna - Better Auth Component Configuration
 *
 * This configures the Better Auth component for Convex.
 * The component provides authentication tables and functions.
 *
 * @see https://github.com/convex-dev/better-auth-convex
 */

import { defineComponent } from "convex/server";

// Local install component definition for Convex + Better Auth.
// This allows customizing the Better Auth schema (e.g. organizations plugin).
const component = defineComponent("betterAuth")
  .api(require("./index"));

export default component;
