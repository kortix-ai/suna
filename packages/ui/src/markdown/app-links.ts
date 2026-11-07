export type AppLinkKind =
  | 'pullRequest'
  | 'issue'
  | 'commit'
  | 'githubUser'
  | 'githubRepo'
  | 'linearIssue'
  | 'slackMessage'
  | 'slackConversation'
  | 'figmaDesign'
  | 'figjamBoard'
  | 'figmaSlides'
  | 'notionPage'
  | 'googleDoc'
  | 'googleSheet'
  | 'googleSlides';
export interface AppLink {
  app: 'github' | 'linear' | 'slack' | 'figma' | 'notion' | 'google';
  kind: AppLinkKind;
  number?: string;
  name?: string;
}

// First path segments that are GitHub pages, not an account.
const GITHUB_RESERVED = new Set([
  'about', 'accelerator', 'account', 'apps', 'blog', 'business', 'codespaces',
  'collections', 'community', 'contact', 'copilot', 'customer-stories', 'dashboard',
  'discussions', 'edu', 'education', 'enterprise', 'events', 'explore', 'features',
  'git-guides', 'github-copilot', 'home', 'issues', 'join', 'login', 'logout',
  'marketplace', 'mobile', 'new', 'nonprofit', 'notifications', 'open-source',
  'organizations', 'orgs', 'partners', 'premium-support', 'pricing', 'pulls',
  'readme', 'resources', 'search', 'security', 'services', 'sessions', 'settings',
  'signup', 'site', 'sitemap', 'solutions', 'sponsors', 'stars', 'team', 'topics',
  'trending', 'trust-center', 'watching', 'why-github',
]);

/** Public URL structure only. No metadata requests or inferred live status. */
export function appLink(href: string): AppLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    return null;
  const path = url.pathname;
  if (url.hostname === 'github.com') {
    const resource =
      /^\/[^/]+\/[^/]+\/(pull|issues)\/([1-9]\d{0,8})(?:\/(?:files|commits|checks))?\/?$/.exec(
        path,
      );
    if (resource)
      return {
        app: 'github',
        kind: resource[1] === 'pull' ? 'pullRequest' : 'issue',
        number: resource[2],
      };
    const commit = /^\/[^/]+\/[^/]+\/commit\/([a-f0-9]{7,40})\/?$/.exec(path);
    if (commit)
      return { app: 'github', kind: 'commit', name: commit[1].slice(0, 7) };
    const owner = /^\/([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}))(?:\/([a-zA-Z0-9._-]{1,100}))?\/?$/.exec(path);
    if (owner && !GITHUB_RESERVED.has(owner[1].toLowerCase())) {
      const repo = owner[2];
      if (!repo) return { app: 'github', kind: 'githubUser', name: owner[1] };
      if (repo !== '.' && repo !== '..')
        return { app: 'github', kind: 'githubRepo', name: `${owner[1]}/${repo}` };
    }
  }
  if (url.hostname === 'linear.app') {
    const issue =
      /^\/[^/]+\/issue\/([a-zA-Z][a-zA-Z0-9]{0,9}-[1-9]\d{0,8})(?:\/[^/]+)?\/?$/.exec(path);
    if (issue)
      return {
        app: 'linear',
        kind: 'linearIssue',
        name: issue[1].toUpperCase(),
      };
  }
  if (
    /^(?:[a-z0-9-]+\.)+slack\.com$/.test(url.hostname) &&
    /^\/archives\/[A-Z0-9]+\/p\d+\/?$/.test(path)
  ) {
    return { app: 'slack', kind: 'slackMessage' };
  }
  if (
    url.hostname === 'app.slack.com' &&
    /^\/client\/T[A-Z0-9]+\/[CDG][A-Z0-9]+(?:\/thread\/[^/]+)?\/?$/.test(path)
  ) {
    return { app: 'slack', kind: 'slackConversation' };
  }
  if (url.hostname === 'www.figma.com' || url.hostname === 'figma.com') {
    const file =
      /^\/(design|file|board|slides)\/[a-zA-Z0-9]+(?:\/([^/]+))?\/?$/.exec(
        path,
      );
    if (file)
      return {
        app: 'figma',
        kind:
          file[1] === 'board'
            ? 'figjamBoard'
            : file[1] === 'slides'
              ? 'figmaSlides'
              : 'figmaDesign',
        name: urlTitle(file[2]),
      };
  }
  if (
    (url.hostname === 'notion.so' ||
      /^[a-z0-9-]+\.notion\.so$/.test(url.hostname)) &&
    /[a-f0-9]{32}\/?$/.test(path)
  ) {
    const slug = path
      .replace(/\/$/, '')
      .split('/')
      .pop()
      ?.replace(/-?[a-f0-9]{32}$/, '');
    return { app: 'notion', kind: 'notionPage', name: urlTitle(slug) };
  }
  if (url.hostname === 'docs.google.com') {
    const file =
      /^\/(document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/[a-zA-Z0-9_-]+(?:\/(?:edit|view|preview|copy))?\/?$/.exec(
        path,
      );
    if (file)
      return {
        app: 'google',
        kind:
          file[1] === 'document'
            ? 'googleDoc'
            : file[1] === 'spreadsheets'
              ? 'googleSheet'
              : 'googleSlides',
      };
  }
  return null;
}

function urlTitle(slug?: string): string | undefined {
  if (!slug) return undefined;
  try {
    const title = decodeURIComponent(slug)
      .replace(/-/g, ' ')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim();
    return title && title.length <= 48 ? title : undefined;
  } catch {
    return undefined;
  }
}
