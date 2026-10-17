/**
 * Common work apps and websites, so an admin picks "Slack" instead of typing
 * `com.tinyspeck.slackmacgap` and `slack.exe`. Each app lists its macOS bundle id
 * and its Windows executable: adding the app adds both, one row shows it by name.
 */
export interface CatalogApp {
  name: string;
  ids: string[];
  /** Offered as a one-click "Common app"; false for apps listed only to name a category's members. */
  common?: boolean;
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
  {
    name: 'WhatsApp',
    ids: ['net.whatsapp.WhatsApp', 'desktop.WhatsApp', 'whatsapp.exe', 'whatsapp'],
  },
  { name: 'Messages', ids: ['com.apple.MobileSMS'] },
  // The members of the categories (exclusion-groups.json), by name.
  {
    name: '1Password',
    ids: [
      'com.1password.1password',
      'com.agilebits.onepassword7',
      'com.agilebits.onepassword-osx',
      '1password.exe',
      '1password',
    ],
    common: false,
  },
  {
    name: 'Bitwarden',
    ids: ['com.bitwarden.desktop', 'bitwarden.exe', 'bitwarden'],
    common: false,
  },
  { name: 'LastPass', ids: ['com.lastpass.LastPass', 'lastpass.exe'], common: false },
  { name: 'Dashlane', ids: ['com.dashlane.Dashlane', 'dashlane.exe'], common: false },
  {
    name: 'KeePassXC',
    ids: ['org.keepassxc.keepassxc', 'keepassxc.exe', 'keepassxc'],
    common: false,
  },
  { name: 'KeePass', ids: ['keepass.exe'], common: false },
  { name: 'Keychain Access', ids: ['com.apple.keychainaccess'], common: false },
  { name: 'Passwords', ids: ['com.apple.Passwords'], common: false },
  { name: 'Enpass', ids: ['in.sinew.Enpass-Desktop', 'enpass.exe', 'enpass'], common: false },
  { name: 'NordPass', ids: ['com.nordpass.macos.NordPass', 'nordpass.exe'], common: false },
  { name: 'Proton Pass', ids: ['com.proton.pass', 'proton pass.exe'], common: false },
  {
    name: 'Telegram',
    ids: ['ru.keepcoder.Telegram', 'org.telegram.desktop', 'telegram.exe', 'telegram-desktop'],
    common: false,
  },
  {
    name: 'Signal',
    ids: ['org.whispersystems.signal-desktop', 'signal.exe', 'signal'],
    common: false,
  },
  { name: 'Messenger', ids: ['com.facebook.archon'], common: false },
  { name: 'Discord', ids: ['com.hnc.Discord', 'discord.exe', 'discord'], common: false },
  {
    name: 'WeChat',
    ids: ['com.tencent.xinwechat', 'wechat.exe', 'weixin.exe', 'wechat'],
    common: false,
  },
  {
    name: 'Notification banners',
    ids: ['com.apple.notificationcenterui', 'shellexperiencehost.exe'],
    common: false,
  },
  { name: 'Stocks', ids: ['com.apple.stocks'], common: false },
  { name: 'Banktivity', ids: ['com.banktivity.banktivity'], common: false },
  {
    name: 'Ledger Live',
    ids: ['com.ledger.live', 'ledger live.exe', 'ledger-live-desktop'],
    common: false,
  },
  { name: 'Moneydance', ids: ['com.moneydance.moneydance', 'moneydance.exe'], common: false },
  { name: 'Quicken', ids: ['com.quicken.quicken', 'quicken.exe'], common: false },
  { name: 'YNAB', ids: ['com.youneedabudget.ynab'], common: false },
  { name: 'Electrum', ids: ['org.electrum.electrum', 'electrum', 'electrum.exe'], common: false },
  { name: 'Exodus', ids: ['exodus', 'exodus.exe'], common: false },
  { name: 'MetaTrader', ids: ['metatrader.exe', 'terminal64.exe'], common: false },
  { name: 'QuickBooks', ids: ['quickbooks.exe'], common: false },
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
      app.common !== false &&
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
