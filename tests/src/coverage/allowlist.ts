export interface AllowEntry {
  method: string;
  path: string;
  reason: string;
}

export const uncoveredAllow: AllowEntry[] = [];

export const externalRoutes: AllowEntry[] = [];
