import { createAuth } from "../auth";

// Static instance for `npx auth generate` only.
export const auth = createAuth({} as any);
