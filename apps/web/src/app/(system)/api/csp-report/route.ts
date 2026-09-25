import { summarizeCspReport } from '@/lib/security/content-security-policy';

export const dynamic = 'force-dynamic';

/** Reports larger than this are not CSP reports. */
const MAX_REPORT_BYTES = 16 * 1024;

/**
 * Receives `Content-Security-Policy-Report-Only` violation reports (see
 * lib/security/content-security-policy.ts) and logs one line per report:
 * the directive, the blocked origin and the page's first path segment. Never
 * the full page URL, which can carry an email or a capability token.
 */
export async function POST(request: Request) {
  const text = await request.text().catch(() => '');
  if (text.length > 0 && text.length <= MAX_REPORT_BYTES) {
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const summary = summarizeCspReport(body);
    if (summary) console.warn('[csp-report]', summary);
  }
  return new Response(null, { status: 204 });
}
