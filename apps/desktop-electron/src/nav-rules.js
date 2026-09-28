// Desktop navigation rules — pure, no Electron. main.js uses them in the
// top-frame navigation gate: what renders in the app window, and what opens in
// the user's real browser instead.

// Sandbox previews / tunnels — user content, always in-app.
function isPreviewHost(host) {
  return (
    host.endsWith('.localhost') ||
    host === 'kortix.cloud' ||
    host.endsWith('.kortix.cloud')
  );
}

// Product route prefixes allowed to render in the desktop window. MUST equal
// DESKTOP_ALLOWED_ROUTES in apps/web/src/middleware.ts; nav-rules.test.js
// fails when they differ. A route the middleware allows but this list does not
// opens in the system browser on a full-page load, and the app window stays
// where it was — a soft lock, because the shell has no Back.
const APP_PATH_PREFIXES = [
  '/projects',
  '/new',
  '/settings',
  '/invites',
  '/admin',
  '/setup',
  '/connectors',
  '/oauth',
  '/checkout',
  '/tunnel',
  '/github',
  '/cli',
  '/marketplace',
  '/maintenance',
  '/countryerror',
  '/debug',
];

function isAppPath(pathname) {
  // The site root stays in-app: on desktop the middleware sends it to the
  // landing door. Opening it in the browser strands the window instead.
  if (pathname === '/') return true;
  if (pathname === '/auth' || pathname.startsWith('/auth/')) return true;
  return APP_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

module.exports = { APP_PATH_PREFIXES, isAppPath, isPreviewHost };
