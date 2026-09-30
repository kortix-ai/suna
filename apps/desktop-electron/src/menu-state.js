const { isAppPath } = require('./nav-rules');

/**
 * The URL a "Copy Current URL" action puts on the clipboard, or null when the
 * window is not on an app page (about:blank, a Chrome error page, a page a
 * redirect committed outside the app): only those open the same session when
 * pasted.
 */
function copyableUrl(url) {
  try {
    const parsed = new URL(url);
    const http = parsed.protocol === 'https:' || parsed.protocol === 'http:';
    return http && isAppPath(parsed.pathname) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function menuContextForUrl(url) {
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    return { inProject: false, hasActiveTab: false };
  }
  const projectId = /^\/projects\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
  const inProject = Boolean(projectId && projectId !== 'start' && projectId !== 'new');
  const hasActiveTab = inProject && /^\/projects\/[^/]+\/(?:sessions\/[^/]+|customize)(?:\/|$)/.test(pathname);
  return { inProject, hasActiveTab };
}

module.exports = { menuContextForUrl, copyableUrl };
