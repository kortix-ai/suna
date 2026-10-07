/**
 * The inbound webhook signing scheme, in one place: the header, the algorithm,
 * and the copy-pasteable sample request both the dashboard's trigger sheet and
 * `kortix triggers info` render. The wire behavior itself is
 * `verifyWebhookSignature` in `apps/api/src/projects/lib/triggers.ts`.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'X-Kortix-Signature';
export const WEBHOOK_SIGNATURE_ALGORITHM = 'HMAC-SHA256 over the exact raw request body';

/** A copy-pasteable request for whoever is wiring the other end up. */
export function buildWebhookSampleRequest(url: string): string {
  return [
    `curl -X POST ${url} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "${WEBHOOK_SIGNATURE_HEADER}: sha256=$(echo -n '$BODY' | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')" \\`,
    `  -d '$BODY'`,
    '',
    `# $BODY   is the JSON you want to send, e.g. {"event":"deploy.succeeded"}`,
    '# $SECRET is the signing key you saved for this webhook',
  ].join('\n');
}
