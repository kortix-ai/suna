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

module.exports = { menuContextForUrl };
