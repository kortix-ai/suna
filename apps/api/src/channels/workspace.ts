export function workspaceIdFromRaw(raw: unknown): string {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.team === 'string' && r.team) return r.team;
    if (typeof r.team_id === 'string' && r.team_id) return r.team_id;
    if (r.team && typeof r.team === 'object') {
      const id = (r.team as Record<string, unknown>).id;
      if (typeof id === 'string' && id) return id;
    }
    if (r.user && typeof r.user === 'object') {
      const teamId = (r.user as Record<string, unknown>).team_id;
      if (typeof teamId === 'string' && teamId) return teamId;
    }
  }
  return '';
}
