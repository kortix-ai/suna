import { describe, expect, test } from 'bun:test';
import {
  WEBHOOK_SIGNATURE_ALGORITHM,
  WEBHOOK_SIGNATURE_HEADER,
  buildWebhookSampleRequest,
} from './webhook-signing';

describe('buildWebhookSampleRequest', () => {
  test('names the header the API authenticates and signs the exact body', () => {
    const sample = buildWebhookSampleRequest('https://api.example.test/v1/webhooks/projects/p/h');
    expect(sample).toContain('curl -X POST https://api.example.test/v1/webhooks/projects/p/h');
    expect(sample).toContain(
      `${WEBHOOK_SIGNATURE_HEADER}: sha256=$(echo -n '$BODY' | openssl dgst -sha256 -hmac "$SECRET"`,
    );
    // The `sed 's/^.* //'` strips openssl's "(stdin)=" label, so the header
    // carries the bare hex digest the server compares.
    expect(sample).toContain("sed 's/^.* //'");
  });

  test('explains both placeholders, so the caller knows what to substitute', () => {
    const sample = buildWebhookSampleRequest('https://api.example.test/v1/webhooks/projects/p/h');
    expect(sample).toContain(
      '# $BODY   is the JSON you want to send, e.g. {"event":"deploy.succeeded"}',
    );
    expect(sample).toContain('# $SECRET is the signing key you saved for this webhook');
    expect(WEBHOOK_SIGNATURE_ALGORITHM).toContain('HMAC-SHA256');
  });
});
