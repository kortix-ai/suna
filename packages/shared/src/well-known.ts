/** Public discovery for service-only origins; never enumerate private routes. */
export function wellKnownResponse(pathname: string): Response | null {
  let body: string;
  let contentType = 'text/plain; charset=utf-8';
  switch (pathname) {
    case '/.well-known/security.txt': {
      const expires = new Date(Date.now() + 180 * 86400000).toISOString();
      body = ['Contact: mailto:security@kortix.com', 'Expires: ' + expires, 'Preferred-Languages: en', ''].join('\n');
      break;
    }
    case '/robots.txt':
      body = ['User-agent: *', 'Disallow: /', ''].join('\n');
      break;
    case '/sitemap.xml':
      contentType = 'application/xml; charset=utf-8';
      body = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>';
      break;
    default:
      return null;
  }
  return new Response(body, { headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' } });
}
