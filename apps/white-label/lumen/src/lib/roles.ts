/** Better Auth roles as Lumen names them. */
export const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Lawyer' };

export const roleLabel = (role: string) => ROLE_LABEL[role] ?? role;

export const isAdmin = (role: string | null | undefined) => role === 'owner' || role === 'admin';

export const PLAN_LABEL: Record<string, string> = { trial: 'Trial', solo: 'Solo', team: 'Team', firm: 'Firm' };

export const STATUS_LABEL: Record<string, string> = { open: 'Open', on_hold: 'On hold', closed: 'Closed' };

export const PARTY_ROLES = ['client', 'counterparty', 'target', 'landlord', 'tenant', 'employee', 'other'] as const;
