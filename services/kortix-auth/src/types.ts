import type { Context } from 'hono';

// Context variables set by auth middleware
export interface AuthVariables {
  userId: string;
  userEmail: string;
}

// Typed context with auth variables
export type AuthContext = Context<{ Variables: AuthVariables }>;
