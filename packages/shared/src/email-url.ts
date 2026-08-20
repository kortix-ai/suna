// One connection string per email provider: EMAIL_URL.
//
// Before this module every provider had its own bespoke pair of env vars
// (RESEND_API_KEY, AWS_SES_ACCESS_KEY_ID + AWS_SES_SECRET_ACCESS_KEY +
// AWS_SES_REGION, MAILTRAP_API_TOKEN, MAILPIT_API_URL) and plain SMTP was not
// supported at all — which meant a self-hoster with an ordinary mail relay had
// no way to send product email, and every new provider added three more keys.
// EMAIL_URL collapses all of that into one string whose scheme selects the
// transport:
//
//   smtp://user:pass@mail.example.com:587    STARTTLS (opportunistic; forced
//                                            whenever credentials are present)
//   smtps://user:pass@mail.example.com:465   implicit TLS
//   resend://re_xxxxxxxx
//   ses://AKIA...:secret@us-east-2           static credentials
//   ses://us-east-2                          instance/task role credentials
//   mailtrap://<api-token>
//   mailpit://127.0.0.1:8025                 local capture (HTTP API)
//
// Comma-separate several to get a fallback chain, tried left to right:
//   EMAIL_URL=ses://us-east-2,resend://re_xxxxxxxx
//
// Parsing is deliberately hand-rolled rather than `new URL()`: WHATWG URL
// lowercases the host, and provider credentials are case-sensitive. An API key
// placed in the host position (`resend://re_AbC`) would be silently corrupted
// to `re_abc` and every send would 401 with no hint why.

export type EmailTargetKind = 'smtp' | 'resend' | 'ses' | 'mailtrap' | 'mailpit';

export type EmailTarget =
  | {
      kind: 'smtp';
      host: string;
      port: number;
      /** Implicit TLS from the first byte (port 465 / `smtps:`). */
      secure: boolean;
      /** Refuse to continue unless STARTTLS upgrades the connection. */
      requireTls: boolean;
      /** `false` only via `?insecure=1` — self-signed relay certificates. */
      rejectUnauthorized: boolean;
      user?: string;
      pass?: string;
    }
  | { kind: 'resend'; apiKey: string }
  | { kind: 'ses'; region: string; accessKeyId?: string; secretAccessKey?: string }
  | { kind: 'mailtrap'; token: string }
  | { kind: 'mailpit'; baseUrl: string };

export class EmailUrlError extends Error {}

const DEFAULT_SMTP_PORT = 587;
const IMPLICIT_TLS_PORT = 465;

/**
 * Trim trailing slashes without a regex. `/\/+$/` against a long run of
 * slashes backtracks polynomially, and EMAIL_URL — while operator-set — is
 * parsed by an exported library function, so it gets library-grade handling.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

/** Split on the LAST `@` so an un-encoded `@` inside a password still parses. */
function splitUserInfo(rest: string): { userInfo: string | null; remainder: string } {
  const at = rest.lastIndexOf('@');
  if (at === -1) return { userInfo: null, remainder: rest };
  return { userInfo: rest.slice(0, at), remainder: rest.slice(at + 1) };
}

function splitQuery(rest: string): { body: string; query: URLSearchParams } {
  const mark = rest.indexOf('?');
  if (mark === -1) return { body: rest, query: new URLSearchParams() };
  return { body: rest.slice(0, mark), query: new URLSearchParams(rest.slice(mark + 1)) };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `host:port`, `host`, `[::1]:port` — port optional. */
function splitHostPort(input: string): { host: string; port: number | null } {
  const trimmed = stripTrailingSlashes(input);
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close === -1) throw new EmailUrlError(`unterminated IPv6 host in "${input}"`);
    const host = trimmed.slice(1, close);
    const tail = trimmed.slice(close + 1);
    if (!tail) return { host, port: null };
    if (!tail.startsWith(':')) throw new EmailUrlError(`unexpected "${tail}" after IPv6 host`);
    return { host, port: parsePort(tail.slice(1)) };
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon === -1) return { host: trimmed, port: null };
  return { host: trimmed.slice(0, colon), port: parsePort(trimmed.slice(colon + 1)) };
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new EmailUrlError(`invalid port "${raw}"`);
  }
  return port;
}

function isTrue(value: string | null): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

function parseSmtp(scheme: string, rest: string): EmailTarget {
  const { body, query } = splitQuery(rest);
  const { userInfo, remainder } = splitUserInfo(body);
  if (!remainder) throw new EmailUrlError('missing SMTP host');

  const { host, port: explicitPort } = splitHostPort(remainder);
  if (!host) throw new EmailUrlError('missing SMTP host');

  let user: string | undefined;
  let pass: string | undefined;
  if (userInfo) {
    const colon = userInfo.indexOf(':');
    user = decode(colon === -1 ? userInfo : userInfo.slice(0, colon));
    pass = colon === -1 ? undefined : decode(userInfo.slice(colon + 1));
  }

  const tls = (query.get('tls') || '').toLowerCase();
  const port = explicitPort ?? (scheme === 'smtps' ? IMPLICIT_TLS_PORT : DEFAULT_SMTP_PORT);
  const secure = scheme === 'smtps' || port === IMPLICIT_TLS_PORT || tls === 'implicit';

  // Credentials never travel in the clear: whenever a password would be sent,
  // STARTTLS is mandatory unless the operator explicitly opts out with
  // `?tls=off`. An anonymous relay (a local Mailpit, an internal MTA on :25)
  // stays opportunistic so it keeps working with no flags.
  const hasCredentials = Boolean(user || pass);
  const requireTls = !secure && tls !== 'off' && (hasCredentials || tls === 'required');

  return {
    kind: 'smtp',
    host,
    port,
    secure,
    requireTls,
    rejectUnauthorized: !isTrue(query.get('insecure')),
    ...(user ? { user } : {}),
    ...(pass ? { pass } : {}),
  };
}

function parseSes(rest: string): EmailTarget {
  const { body } = splitQuery(rest);
  const { userInfo, remainder } = splitUserInfo(body);
  const region = stripTrailingSlashes(remainder).toLowerCase();
  if (!region) throw new EmailUrlError('missing SES region (ses://<region>)');
  if (!userInfo) return { kind: 'ses', region };

  const colon = userInfo.indexOf(':');
  if (colon === -1) {
    throw new EmailUrlError('SES credentials must be ses://<key-id>:<secret>@<region>');
  }
  return {
    kind: 'ses',
    region,
    accessKeyId: decode(userInfo.slice(0, colon)),
    secretAccessKey: decode(userInfo.slice(colon + 1)),
  };
}

function parseMailpit(rest: string): EmailTarget {
  const { body } = splitQuery(rest);
  const target = stripTrailingSlashes(body);
  if (!target) throw new EmailUrlError('missing Mailpit host');
  const baseUrl = /^https?:\/\//i.test(target) ? target : `http://${target}`;
  return { kind: 'mailpit', baseUrl };
}

/** Parse one EMAIL_URL entry. Throws EmailUrlError with an operator-readable reason. */
export function parseEmailTarget(raw: string): EmailTarget {
  const value = raw.trim();
  const sep = value.indexOf('://');
  if (sep === -1) {
    throw new EmailUrlError(
      `"${redactUrl(value)}" is not a URL — expected e.g. smtp://user:pass@host:587`,
    );
  }
  const scheme = value.slice(0, sep).toLowerCase();
  const rest = value.slice(sep + 3);

  switch (scheme) {
    case 'smtp':
    case 'smtps':
      return parseSmtp(scheme, rest);
    case 'resend': {
      const apiKey = stripTrailingSlashes(splitQuery(rest).body);
      if (!apiKey) throw new EmailUrlError('missing Resend API key (resend://<api-key>)');
      return { kind: 'resend', apiKey };
    }
    case 'ses':
      return parseSes(rest);
    case 'mailtrap': {
      const token = stripTrailingSlashes(splitQuery(rest).body);
      if (!token) throw new EmailUrlError('missing Mailtrap token (mailtrap://<api-token>)');
      return { kind: 'mailtrap', token };
    }
    case 'mailpit':
      return parseMailpit(rest);
    default:
      throw new EmailUrlError(
        `unsupported email scheme "${scheme}" — use smtp, smtps, resend, ses, mailtrap or mailpit`,
      );
  }
}

/**
 * Parse a comma-separated EMAIL_URL into an ordered fallback chain. Invalid
 * entries are reported rather than thrown so one typo cannot take down every
 * remaining provider — the caller logs `errors` and sends through `targets`.
 */
export function parseEmailTargets(raw: string | undefined | null): {
  targets: EmailTarget[];
  errors: string[];
} {
  const targets: EmailTarget[] = [];
  const errors: string[] = [];
  for (const entry of (raw || '').split(',')) {
    const value = entry.trim();
    if (!value) continue;
    try {
      targets.push(parseEmailTarget(value));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { targets, errors };
}

/** Strip credentials from a URL so it is safe to put in a log line. */
export function redactUrl(raw: string): string {
  const sep = raw.indexOf('://');
  if (sep === -1) return raw;
  const scheme = raw.slice(0, sep);
  const rest = raw.slice(sep + 3);
  if (scheme === 'smtp' || scheme === 'smtps' || scheme === 'ses') {
    const at = rest.lastIndexOf('@');
    return at === -1 ? `${scheme}://${rest}` : `${scheme}://***@${rest.slice(at + 1)}`;
  }
  return `${scheme}://***`;
}
