/**
 * Ephemeral per-sandbox certificate authority for the egress proxy.
 *
 * Injecting a header into an HTTPS request means terminating the TLS the guest
 * opened, which means presenting a certificate the guest will accept. So the
 * proxy needs a CA the guest trusts.
 *
 * Two properties are deliberate:
 *
 *  - **Per sandbox, not per platform.** A single long-lived Kortix root baked
 *    into customer images would be a skeleton key: possess it and you can
 *    impersonate any host to any sandbox we ever shipped. Each sandbox gets its
 *    own CA, minted at provision and thrown away with the sandbox, so the blast
 *    radius of a leaked key is one short-lived box.
 *  - **Short validity.** Hours, not years. A CA that escapes is useless
 *    tomorrow.
 *
 * Leaves are issued on demand per SNI host and cached for the CA's lifetime —
 * a fresh 2048-bit keypair costs ~100ms, which is far too slow to pay on every
 * CONNECT.
 */
import { createHash, randomBytes } from 'node:crypto';
import forge from 'node-forge';

export interface EphemeralCa {
  /** PEM the guest must trust (system bundle + the per-runtime env vars). */
  readonly certPem: string;
  /** PEM private key. Never leaves the proxy process. */
  readonly keyPem: string;
  readonly notAfter: Date;
  /** SHA-256 of the DER cert, for logs and for asserting guest trust. */
  readonly fingerprint: string;
}

export interface LeafCertificate {
  readonly certPem: string;
  readonly keyPem: string;
}

/** 12h: comfortably longer than a session, far shorter than a useful theft. */
const DEFAULT_CA_TTL_MS = 12 * 60 * 60 * 1000;
/** Backdate so a guest whose clock trails the proxy's does not reject the cert. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const KEY_BITS = 2048;

function serial(): string {
  // Positive integer: a leading byte >= 0x80 is read as negative by some
  // parsers and the certificate is then rejected outright.
  return `00${randomBytes(16).toString('hex')}`;
}

function fingerprintOf(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex');
}

/**
 * Mint a CA for one sandbox. `label` only shows up in the subject, so a human
 * reading a cert chain in the guest can tell what issued it.
 */
export function createEphemeralCa(label: string, ttlMs: number = DEFAULT_CA_TTL_MS): EphemeralCa {
  const keys = forge.pki.rsa.generateKeyPair(KEY_BITS);
  const cert = forge.pki.createCertificate();
  const now = Date.now();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(now - CLOCK_SKEW_MS);
  cert.validity.notAfter = new Date(now + ttlMs);

  const subject = [
    { name: 'commonName', value: `Kortix Egress CA (${label})` },
    { name: 'organizationName', value: 'Kortix' },
  ];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    // pathLenConstraint 0: this CA may sign leaves and nothing else. It cannot
    // be used to mint another CA.
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    notAfter: cert.validity.notAfter,
    fingerprint: fingerprintOf(cert),
  };
}

/** Issues and caches leaf certificates for the hosts the proxy terminates. */
export class LeafIssuer {
  private readonly cache = new Map<string, LeafCertificate>();
  private readonly caCert: forge.pki.Certificate;
  /**
   * `privateKeyFromPem` is typed as the general `PrivateKey`, but `sign()`
   * requires the RSA variant. Narrowed here rather than at the call site: the
   * CA is minted by `createEphemeralCa` with `rsa.generateKeyPair`, so it is
   * RSA by construction.
   */
  private readonly caKey: forge.pki.rsa.PrivateKey;
  private readonly notAfter: Date;

  constructor(ca: EphemeralCa) {
    this.caCert = forge.pki.certificateFromPem(ca.certPem);
    this.caKey = forge.pki.privateKeyFromPem(ca.keyPem) as forge.pki.rsa.PrivateKey;
    this.notAfter = ca.notAfter;
  }

  /**
   * A certificate for `host`, valid no longer than the CA that signed it.
   *
   * The SAN is what modern clients actually check — a matching commonName with
   * no SAN is rejected by Node, Go, and every browser — so the host goes in
   * both.
   */
  issue(host: string): LeafCertificate {
    const cached = this.cache.get(host);
    if (cached) return cached;

    const keys = forge.pki.rsa.generateKeyPair(KEY_BITS);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - CLOCK_SKEW_MS);
    cert.validity.notAfter = this.notAfter;
    cert.setSubject([{ name: 'commonName', value: host }]);
    cert.setIssuer(this.caCert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        // type 2 = dNSName, type 7 = iPAddress. A literal-IP destination needs
        // the iPAddress form; a dNSName of "1.2.3.4" does not match.
        altNames: [
          /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
            ? { type: 7, ip: host }
            : { type: 2, value: host },
        ],
      },
    ]);
    cert.sign(this.caKey, forge.md.sha256.create());

    const leaf: LeafCertificate = {
      certPem: forge.pki.certificateToPem(cert),
      keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    };
    this.cache.set(host, leaf);
    return leaf;
  }
}
