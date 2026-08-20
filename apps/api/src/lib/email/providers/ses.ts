// AWS SES v2 SendEmail over a SigV4-signed fetch. Hand-signed with node:crypto
// so the API keeps no AWS SDK client dependency; only the credential provider
// is borrowed, and only when the DSN carries no static key pair (ECS task role,
// EKS web identity).
import { createHash, createHmac } from 'node:crypto';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

import { formatEmailAddress } from '../address';
import type { EmailTarget } from '@kortix/shared/email-url';
import { EMAIL_SEND_TIMEOUT_MS, type EmailSendResult, type ResolvedEmailMessage } from '../types';

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export async function sendViaSes(
  msg: ResolvedEmailMessage,
  target: Extract<EmailTarget, { kind: 'ses' }>,
): Promise<EmailSendResult> {
  const region = target.region;
  const host = `email.${region}.amazonaws.com`;
  const path = '/v2/email/outbound-emails';
  const credentials =
    target.accessKeyId && target.secretAccessKey
      ? { accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey }
      : await defaultProvider()();

  const body = JSON.stringify({
    FromEmailAddress: formatEmailAddress(msg.from),
    Destination: { ToAddresses: msg.to },
    ...(msg.replyTo ? { ReplyToAddresses: [msg.replyTo] } : {}),
    Content: {
      Simple: {
        Subject: { Data: msg.subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: msg.html, Charset: 'UTF-8' },
          ...(msg.text ? { Text: { Data: msg.text, Charset: 'UTF-8' } } : {}),
        },
      },
    },
    EmailTags: [{ Name: 'category', Value: msg.category }],
  });

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const sessionToken = (credentials as { sessionToken?: string }).sessionToken;
  const securityTokenHeader = sessionToken ? `x-amz-security-token:${sessionToken}\n` : '';
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n${securityTokenHeader}`;
  const signedHeaders = sessionToken
    ? 'content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token'
    : 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `POST\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${region}/ses/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), region), 'ses'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  const res = await fetch(`https://${host}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Amz-Content-Sha256': payloadHash,
      'X-Amz-Date': amzDate,
      ...(sessionToken ? { 'X-Amz-Security-Token': sessionToken } : {}),
      Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, provider: 'ses', status: res.status, error: text || res.statusText };
  }
  return { ok: true, provider: 'ses', status: res.status };
}
