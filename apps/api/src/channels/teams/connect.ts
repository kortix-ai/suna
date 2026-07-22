/**
 * Microsoft Teams connect/onboarding logic, lifted out of the bespoke
 * `/channels/teams/*` route handlers in projects/routes/r4.ts so the connector
 * descriptor (registry/teams.ts) is the single owner of channel behavior. The
 * status codes and error bodies are preserved exactly (400 for a malformed
 * tenant/app id) via ChannelError.
 */
import { ChannelError } from '../registry/descriptor';

/** Default profile slug for the built-in Teams channel. */
export const TEAMS_DEFAULT_SLUG = 'kortix_teams';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

export function isTeamsGuid(value: string): boolean {
  return GUID_RE.test(value);
}

export function isTeamsDomain(value: string): boolean {
  return DOMAIN_RE.test(value);
}

export interface TeamsConnectBody {
  tenant_id?: string;
  team_name?: string;
  app_id?: string;
  app_password?: string;
}

export interface PreparedTeamsConnect {
  tenantId: string;
  teamName: string | null;
  appId: string | null;
  appPassword: string | null;
}

/**
 * Validate an inbound Teams connect body. Pure of persistence — the descriptor
 * saves the install + reconciles. Throws ChannelError(400) with the exact
 * messages the old POST /channels/teams/connect handler returned.
 */
export function prepareTeamsConnect(body: TeamsConnectBody): PreparedTeamsConnect {
  const tenantId = body.tenant_id?.trim();
  if (!tenantId || (!isTeamsGuid(tenantId) && !isTeamsDomain(tenantId))) {
    throw new ChannelError(400, {
      error: 'tenant_id is required and must be an Azure AD tenant GUID or domain',
    });
  }

  const appId = body.app_id?.trim() || null;
  const appPassword = body.app_password?.trim() || null;
  if ((appId && !appPassword) || (!appId && appPassword)) {
    throw new ChannelError(400, {
      error: 'app_id and app_password must be provided together for a bring-your-own bot',
    });
  }
  if (appId && !isTeamsGuid(appId)) {
    throw new ChannelError(400, { error: 'app_id must be an Azure AD application (client) GUID' });
  }

  return {
    tenantId,
    teamName: body.team_name?.trim() || null,
    appId,
    appPassword,
  };
}
