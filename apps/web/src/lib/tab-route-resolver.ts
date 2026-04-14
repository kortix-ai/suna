/**
 * tab-route-resolver.ts
 *
 * Maps URL pathnames that are handled exclusively by the client-side tab system
 * (pre-mounted in SessionTabsContainer via CSS show/hide) to their corresponding
 * Tab descriptors.
 *
 * Used by:
 *  - Individual page.tsx files (e.g. /browser/page.tsx, /desktop/page.tsx)
 *  - The catch-all [...catchAll]/page.tsx in the (dashboard) route group
 *
 * This is the single source of truth for "which URL opens which tab".
 */

import type { TabType } from '@/stores/tab-store';

export interface TabDescriptor {
  id: string;
  title: string;
  type: TabType;
  href: string;
  /** Optional extra metadata stored on the tab */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Static route → tab descriptor mapping
// ---------------------------------------------------------------------------

const STATIC_TAB_ROUTES: Record<string, TabDescriptor> = {
  // ── Special tools ──────────────────────────────────────────────────────────
  '/browser': {
    id: 'browser:main',
    title: 'Browser',
    type: 'browser',
    href: '/browser',
  },
  '/desktop': {
    id: 'desktop:main',
    title: 'Desktop',
    type: 'desktop',
    href: '/desktop',
  },
  '/service-manager': {
    id: 'service-manager',
    title: 'Service Manager',
    type: 'services',
    href: '/service-manager',
  },
  '/services/running': {
    id: 'service-manager',
    title: 'Service Manager',
    type: 'services',
    href: '/service-manager',
  },

  // ── Page / settings tabs (rendered by PageTabContent) ────────────────────
  '/dashboard': {
    id: 'page:/dashboard',
    title: 'Dashboard',
    type: 'dashboard',
    href: '/dashboard',
  },
  '/workspace': {
    id: 'page:/workspace',
    title: 'Workspace',
    type: 'page',
    href: '/workspace',
  },
  '/configuration': {
    id: 'page:/configuration',
    title: 'Configuration',
    type: 'page',
    href: '/configuration',
  },
  '/projects': {
    id: 'page:/projects',
    title: 'Projects',
    type: 'page',
    href: '/projects',
  },
  '/marketplace': {
    id: 'page:/marketplace',
    title: 'Marketplace',
    type: 'page',
    href: '/marketplace',
  },
  '/skills': {
    id: 'page:/skills',
    title: 'Skills',
    type: 'page',
    href: '/skills',
  },
  '/tools': {
    id: 'page:/tools',
    title: 'Tools',
    type: 'page',
    href: '/tools',
  },
  '/commands': {
    id: 'page:/commands',
    title: 'Commands',
    type: 'page',
    href: '/commands',
  },
  '/scheduled-tasks': {
    id: 'page:/scheduled-tasks',
    title: 'Scheduled Tasks',
    type: 'page',
    href: '/scheduled-tasks',
  },
  '/channels': {
    id: 'page:/channels',
    title: 'Channels',
    type: 'page',
    href: '/channels',
  },
  '/connectors': {
    id: 'page:/connectors',
    title: 'Connectors',
    type: 'page',
    href: '/connectors',
  },
  '/files': {
    id: 'page:/files',
    title: 'Files',
    type: 'page',
    href: '/files',
  },
  '/tunnel': {
    id: 'page:/tunnel',
    title: 'Tunnel',
    type: 'page',
    href: '/tunnel',
  },
  '/deployments': {
    id: 'page:/deployments',
    title: 'Deployments',
    type: 'page',
    href: '/deployments',
  },
  '/changelog': {
    id: 'page:/changelog',
    title: 'Changelog',
    type: 'page',
    href: '/changelog',
  },
  '/credits-explained': {
    id: 'page:/credits-explained',
    title: 'Credits',
    type: 'page',
    href: '/credits-explained',
  },
  '/settings/credentials': {
    id: 'page:/settings/credentials',
    title: 'Secrets',
    type: 'settings',
    href: '/settings/credentials',
  },
  '/settings/api-keys': {
    id: 'page:/settings/api-keys',
    title: 'API Keys',
    type: 'settings',
    href: '/settings/api-keys',
  },
  '/settings/providers': {
    id: 'page:/settings/providers',
    title: 'Providers',
    type: 'settings',
    href: '/settings/providers',
  },
  // Admin pages
  '/admin/analytics': {
    id: 'page:/admin/analytics',
    title: 'Analytics',
    type: 'page',
    href: '/admin/analytics',
  },
  '/admin/feedback': {
    id: 'page:/admin/feedback',
    title: 'Feedback',
    type: 'page',
    href: '/admin/feedback',
  },
  '/admin/notifications': {
    id: 'page:/admin/notifications',
    title: 'Notifications',
    type: 'page',
    href: '/admin/notifications',
  },
  '/admin/utils': {
    id: 'page:/admin/utils',
    title: 'Utils',
    type: 'page',
    href: '/admin/utils',
  },
  '/admin/sandbox-pool': {
    id: 'page:/admin/sandbox-pool',
    title: 'Sandbox Pool',
    type: 'page',
    href: '/admin/sandbox-pool',
  },
  '/admin/stateless': {
    id: 'page:/admin/stateless',
    title: 'Stateless',
    type: 'page',
    href: '/admin/stateless',
  },
  '/admin/stress-test': {
    id: 'page:/admin/stress-test',
    title: 'Stress Test',
    type: 'page',
    href: '/admin/stress-test',
  },
  '/admin/access-requests': {
    id: 'page:/admin/access-requests',
    title: 'Access Requests',
    type: 'page',
    href: '/admin/access-requests',
  },
  '/admin/instances': {
    id: 'page:/admin/instances',
    title: 'Instances',
    type: 'page',
    href: '/admin/instances',
  },
  '/admin/sandboxes': {
    id: 'page:/admin/instances',
    title: 'Instances',
    type: 'page',
    href: '/admin/instances',
  },
};

// ---------------------------------------------------------------------------
// Dynamic pattern resolvers — run in order, first match wins
// ---------------------------------------------------------------------------

type DynamicResolver = (pathname: string) => TabDescriptor | null;

const DYNAMIC_RESOLVERS: DynamicResolver[] = [
  // /admin/sandboxes/<id>
  (pathname) => {
    const instanceMatch = pathname.match(/^\/admin\/instances\/([^/]+)$/);
    if (instanceMatch) {
      const sandboxId = instanceMatch[1];
      return {
        id: `instance:${sandboxId}`,
        title: `Instance · ${sandboxId.slice(0, 8)}`,
        type: 'page',
        href: `/admin/instances/${sandboxId}`,
      };
    }
    return null;
  },

  // /admin/sandboxes/<id>
  (pathname) => {
    const m = pathname.match(/^\/admin\/sandboxes\/([^/]+)$/);
    if (!m) return null;
    const sandboxId = m[1];
    return {
      id: `instance:${sandboxId}`,
      title: `Instance · ${sandboxId.slice(0, 8)}`,
      type: 'page',
      href: `/admin/instances/${sandboxId}`,
    };
  },

  // /sessions/<id>
  (pathname) => {
    const m = pathname.match(/^\/sessions\/([^/]+)$/);
    if (!m) return null;
    const sessionId = m[1];
    return {
      id: sessionId,
      title: 'Session',
      type: 'session',
      href: `/sessions/${sessionId}`,
    };
  },

  // /terminal/<id>
  (pathname) => {
    const m = pathname.match(/^\/terminal\/([^/]+)$/);
    if (!m) return null;
    const ptyId = m[1];
    return {
      id: `terminal:${ptyId}`,
      title: 'Terminal',
      type: 'terminal',
      href: `/terminal/${ptyId}`,
    };
  },

  // /tunnel/<id>
  (pathname) => {
    const m = pathname.match(/^\/tunnel\/([^/]+)$/);
    if (!m) return null;
    const tunnelId = m[1];
    return {
      id: `page:/tunnel/${tunnelId}`,
      title: 'Tunnel',
      type: 'page',
      href: `/tunnel/${tunnelId}`,
    };
  },

  // /p/<port> — preview port
  (pathname) => {
    const m = pathname.match(/^\/p\/([^/]+)$/);
    if (!m) return null;
    const port = m[1];
    return {
      id: `preview:${port}`,
      title: `Port ${port}`,
      type: 'preview',
      href: `/p/${port}`,
      metadata: { port },
    };
  },

  // /files/<...path> — deep file path
  (pathname) => {
    const m = pathname.match(/^\/files\/(.+)$/);
    if (!m) return null;
    const filePath = decodeURIComponent(m[1]);
    const fileName = filePath.split('/').pop() || filePath;
    return {
      id: `file:${filePath}`,
      title: fileName,
      type: 'file',
      href: pathname,
    };
  },

  // /legacy/<threadId>
  (pathname) => {
    const m = pathname.match(/^\/legacy\/([^/]+)$/);
    if (!m) return null;
    const threadId = m[1];
    return {
      id: `page:/legacy/${threadId}`,
      title: 'Legacy Thread',
      type: 'page',
      href: `/legacy/${threadId}`,
    };
  },

  // /tasks/<id> — standalone task detail page
  (pathname) => {
    const m = pathname.match(/^\/tasks\/([^/]+)$/);
    if (!m) return null;
    const taskId = decodeURIComponent(m[1]);
    return {
      id: `task:${taskId}`,
      title: 'Task',
      type: 'page',
      href: `/tasks/${m[1]}`,
    };
  },

  // /projects/<id> — project detail page
  // Title is generic here; the project page component updates it once data loads.
  (pathname) => {
    const m = pathname.match(/^\/projects\/([^/]+)$/);
    if (!m) return null;
    const projectId = decodeURIComponent(m[1]);
    const name = projectId.split('/').pop() || 'Project';
    return {
      id: `project:${projectId}`,
      title: name,
      type: 'project',
      href: `/projects/${m[1]}`,
    };
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a URL pathname to a TabDescriptor.
 *
 * Returns `null` if the pathname is not a recognised tab route (the caller
 * should fall back to redirecting to /dashboard).
 */
export function resolveTabFromPathname(pathname: string): TabDescriptor | null {
  // Exact static match first
  const staticMatch = STATIC_TAB_ROUTES[pathname];
  if (staticMatch) return staticMatch;

  // Try dynamic pattern resolvers
  for (const resolve of DYNAMIC_RESOLVERS) {
    const result = resolve(pathname);
    if (result) return result;
  }

  return null;
}
