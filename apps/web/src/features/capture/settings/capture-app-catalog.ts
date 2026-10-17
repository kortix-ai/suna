/**
 * Common work apps and websites, so an admin picks "Slack" instead of typing
 * `com.tinyspeck.slackmacgap` and `slack.exe`. Each app lists its macOS bundle id
 * and its Windows executable: adding the app adds both, one row shows it by name.
 */
export interface CatalogApp {
  name: string;
  ids: string[];
}

export const CAPTURE_APP_CATALOG: CatalogApp[] = [
  { name: 'Slack', ids: ['com.tinyspeck.slackmacgap', 'slack.exe'] },
  { name: 'Google Chrome', ids: ['com.google.Chrome', 'chrome.exe'] },
  { name: 'Safari', ids: ['com.apple.Safari'] },
  { name: 'Microsoft Edge', ids: ['com.microsoft.edgemac', 'msedge.exe'] },
  { name: 'Firefox', ids: ['org.mozilla.firefox', 'firefox.exe'] },
  { name: 'Arc', ids: ['company.thebrowser.Browser'] },
  { name: 'Zoom', ids: ['us.zoom.xos', 'zoom.exe'] },
  { name: 'Microsoft Teams', ids: ['com.microsoft.teams2', 'ms-teams.exe'] },
  { name: 'Microsoft Outlook', ids: ['com.microsoft.Outlook', 'outlook.exe'] },
  { name: 'Microsoft Excel', ids: ['com.microsoft.Excel', 'excel.exe'] },
  { name: 'Microsoft Word', ids: ['com.microsoft.Word', 'winword.exe'] },
  { name: 'Microsoft PowerPoint', ids: ['com.microsoft.Powerpoint', 'powerpnt.exe'] },
  { name: 'Visual Studio Code', ids: ['com.microsoft.VSCode', 'code.exe'] },
  { name: 'Cursor', ids: ['com.todesktop.230313mzl4w4u92', 'cursor.exe'] },
  { name: 'Figma', ids: ['com.figma.Desktop', 'figma.exe'] },
  { name: 'Notion', ids: ['notion.id', 'notion.exe'] },
  { name: 'Linear', ids: ['com.linear', 'linear.exe'] },
  { name: 'Terminal', ids: ['com.apple.Terminal', 'com.googlecode.iterm2', 'windowsterminal.exe'] },
  { name: 'Finder and File Explorer', ids: ['com.apple.finder', 'explorer.exe'] },
  { name: 'Mail', ids: ['com.apple.mail'] },
  { name: 'Spotify', ids: ['com.spotify.client', 'spotify.exe'] },
  { name: 'WhatsApp', ids: ['net.whatsapp.WhatsApp', 'whatsapp.exe'] },
  { name: 'Messages', ids: ['com.apple.MobileSMS'] },
];

export const CAPTURE_SITE_CATALOG: string[] = [
  'github.com',
  'linear.app',
  'notion.so',
  'figma.com',
  'docs.google.com',
  'mail.google.com',
  'atlassian.net',
  'salesforce.com',
  'hubspot.com',
  'zendesk.com',
];

const byId = new Map(
  CAPTURE_APP_CATALOG.flatMap((app) => app.ids.map((id) => [id.toLowerCase(), app] as const)),
);

/** The catalog app an id belongs to, if any. */
export const catalogApp = (id: string): CatalogApp | undefined => byId.get(id.toLowerCase());

export interface NamedRow {
  /** Every id this row stands for: a catalog app's ids that are in the list, else the one id. */
  ids: string[];
  name: string;
  /** The ids, shown under the name. */
  detail: string;
  locked: boolean;
}

/** A list of app ids as rows: one row per catalog app (by name), one per other id. */
export function namedAppRows(rows: { id: string; locked: boolean }[]): NamedRow[] {
  const out: NamedRow[] = [];
  const seen = new Map<CatalogApp, NamedRow>();
  for (const row of rows) {
    const app = catalogApp(row.id);
    if (!app) {
      out.push({ ids: [row.id], name: row.id, detail: '', locked: row.locked });
      continue;
    }
    const existing = seen.get(app);
    if (existing) {
      existing.ids.push(row.id);
      existing.detail = existing.ids.join(', ');
      existing.locked ||= row.locked;
      continue;
    }
    const named = { ids: [row.id], name: app.name, detail: row.id, locked: row.locked };
    seen.set(app, named);
    out.push(named);
  }
  return out;
}

/** Catalog apps not in `ids` yet, matching `query` (by name), for quick adding. */
export function catalogSuggestions(ids: string[], query: string): CatalogApp[] {
  const have = new Set(ids.map((id) => id.toLowerCase()));
  const q = query.trim().toLowerCase();
  return CAPTURE_APP_CATALOG.filter(
    (app) =>
      !app.ids.every((id) => have.has(id.toLowerCase())) &&
      (!q || app.name.toLowerCase().includes(q)),
  );
}

/** Catalog websites not in `domains` yet, matching `query`. */
export function siteSuggestions(domains: string[], query: string): string[] {
  const have = new Set(domains);
  const q = query.trim().toLowerCase();
  return CAPTURE_SITE_CATALOG.filter((site) => !have.has(site) && (!q || site.includes(q)));
}
