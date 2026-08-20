/**
 * Ephemeral per-sandbox certificate authority for the in-guest egress shim.
 *
 * Injecting a header into an HTTPS request means terminating the TLS the guest
 * opened, which means presenting a certificate the guest will accept. So the
 * shim needs a CA the guest trusts.
 *
 * Two properties are deliberate:
 *
 *  - **Per sandbox, not per platform.** A single long-lived Kortix root baked
 *    into customer images would be a skeleton key: possess it and you can
 *    impersonate any host to any sandbox we ever shipped. Each sandbox mints its
 *    own CA at boot and throws it away with the sandbox, so the blast radius of
 *    a leaked key is one short-lived box.
 *  - **Short validity.** Hours, not years. A CA that escapes is useless
 *    tomorrow.
 *
 * The key never leaves this process — it is not written to disk. Only the
 * public certificate is exported, for the guest's trust stores.
 *
 * Leaves are issued on demand per host and cached for the CA's lifetime — a
 * fresh 2048-bit keypair costs ~100ms, far too slow to pay on every CONNECT.
 */
import { createHash, randomBytes } from 'node:crypto'
import forge from 'node-forge'

export interface EphemeralCa {
  /** PEM the guest must trust (system bundle + the per-runtime env vars). */
  readonly certPem: string
  /** PEM private key. Never written to disk, never leaves this process. */
  readonly keyPem: string
  readonly notAfter: Date
  /** SHA-256 of the DER cert, for logs and for asserting guest trust. */
  readonly fingerprint: string
}

export interface LeafCertificate {
  readonly certPem: string
  readonly keyPem: string
}

/** 12h: comfortably longer than a session, far shorter than a useful theft. */
const DEFAULT_CA_TTL_MS = 12 * 60 * 60 * 1000
/** Backdate so a guest whose clock trails the shim's does not reject the cert. */
const CLOCK_SKEW_MS = 5 * 60 * 1000
const KEY_BITS = 2048

/** Bytes of randomness behind a serial. 16 keeps ~127 bits after clamping,
 *  far past the 64 bits the CA/Browser Forum asks of a serial. */
const SERIAL_BYTES = 16

/**
 * Random bytes → a serial number that is a valid DER INTEGER.
 *
 * DER asks two things of an INTEGER and the old rule only answered one. It
 * returned `'00' + randomBytes(16)`, where the leading zero kept the value
 * POSITIVE — a first byte >= 0x80 is otherwise read as two's-complement
 * negative. True, and not sufficient: a DER INTEGER must also be MINIMAL, and a
 * `0x00` prefix is only legal when the byte after it is >= 0x80. Whenever the
 * first random byte came in below that, the zero was redundant and the
 * certificate was malformed.
 *
 * It failed roughly once in 256 — the odds of `randomBytes()[0] === 0x00`, the
 * case where even forge's own normalization leaves a redundant zero behind. The
 * symptom was `BoringSSL ... ASN.1 ... INVALID_INTEGER` on the handshake, and
 * `openssl x509` refusing to load the certificate at all. Every sandbox mints
 * its own CA and a leaf per terminated host, so that is a real and regular
 * share of agents whose egress TLS simply did not work.
 *
 * Clamping the leading byte into `0x01..0x7f` answers both requirements by
 * construction rather than by case analysis: never >= 0x80, so no prefix byte
 * is ever needed; never `0x00`, so no leading zero is ever redundant. It costs
 * one bit of entropy out of 128.
 *
 * Exported for the tests: a 1-in-256 fault sampled probabilistically is a test
 * that passes while the bug ships, so the rule is pinned directly.
 */
export function serialFromBytes(bytes: Uint8Array): string {
  // A zero-length INTEGER is not valid DER either, so an empty input still has
  // to yield a byte. The only caller passes 16 bytes of randomness; this keeps
  // the function total instead of leaving a second invalid encoding reachable.
  const out = Buffer.from(bytes.length > 0 ? bytes : Uint8Array.of(0x01))
  const first = out[0] ?? 0x01
  out[0] = (first & 0x7f) || 0x01
  return out.toString('hex')
}

function serial(): string {
  return serialFromBytes(randomBytes(SERIAL_BYTES))
}

function fingerprintOf(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  return createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex')
}

/**
 * Mint a CA for one sandbox. `label` only shows up in the subject, so a human
 * reading a cert chain in the guest can tell what issued it.
 */
export function createEphemeralCa(label: string, ttlMs: number = DEFAULT_CA_TTL_MS): EphemeralCa {
  const keys = forge.pki.rsa.generateKeyPair(KEY_BITS)
  const cert = forge.pki.createCertificate()
  const now = Date.now()

  cert.publicKey = keys.publicKey
  cert.serialNumber = serial()
  cert.validity.notBefore = new Date(now - CLOCK_SKEW_MS)
  cert.validity.notAfter = new Date(now + ttlMs)

  const subject = [
    { name: 'commonName', value: `Kortix Egress CA (${label})` },
    { name: 'organizationName', value: 'Kortix' },
  ]
  cert.setSubject(subject)
  cert.setIssuer(subject)
  cert.setExtensions([
    // pathLenConstraint 0: this CA may sign leaves and nothing else. It cannot
    // be used to mint another CA.
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    // Required, not decorative. Python's OpenSSL refuses a chain whose leaf
    // carries no Authority Key Identifier, and an AKI can only reference a
    // Subject Key Identifier that exists on the issuer. Without this pair
    // `requests` fails with `CERTIFICATE_VERIFY_FAILED ... Missing Authority
    // Key Identifier` while curl accepts the same certificate — measured in a
    // real Daytona guest, which is the only place it showed up.
    { name: 'subjectKeyIdentifier' },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    notAfter: cert.validity.notAfter,
    fingerprint: fingerprintOf(cert),
  }
}

/** Issues and caches leaf certificates for the hosts the shim terminates. */
export class LeafIssuer {
  private readonly cache = new Map<string, LeafCertificate>()
  private readonly caCert: forge.pki.Certificate
  /**
   * `privateKeyFromPem` is typed as the general `PrivateKey`, but `sign()`
   * requires the RSA variant. Narrowed here rather than at the call site: the
   * CA is minted by `createEphemeralCa` with `rsa.generateKeyPair`, so it is
   * RSA by construction.
   */
  private readonly caKey: forge.pki.rsa.PrivateKey
  private readonly notAfter: Date
  /** The CA's own key id, so each leaf's AKI can point back at it. */
  private readonly caSubjectKeyId: string

  constructor(ca: EphemeralCa) {
    this.caCert = forge.pki.certificateFromPem(ca.certPem)
    this.caKey = forge.pki.privateKeyFromPem(ca.keyPem) as forge.pki.rsa.PrivateKey
    this.notAfter = ca.notAfter
    // forge computes this from the public key when the extension is generated;
    // read it back off the parsed cert so the leaf references the real bytes
    // rather than a recomputation that could drift.
    // forge's own derivation of the CA public key's identifier, as raw octets.
    // Reading the parsed extension back gives a hex string that forge then
    // re-encodes wrongly, producing a chain OpenSSL rejects with "unable to
    // verify the first certificate" — measured.
    this.caSubjectKeyId = this.caCert.generateSubjectKeyIdentifier().getBytes()
  }

  /**
   * A certificate for `host`, valid no longer than the CA that signed it.
   *
   * The SAN is what modern clients actually check — a matching commonName with
   * no SAN is rejected by Node, Go, and every browser — so the host goes in
   * both.
   */
  issue(host: string): LeafCertificate {
    const cached = this.cache.get(host)
    if (cached) return cached

    const keys = forge.pki.rsa.generateKeyPair(KEY_BITS)
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = serial()
    cert.validity.notBefore = new Date(Date.now() - CLOCK_SKEW_MS)
    cert.validity.notAfter = this.notAfter
    cert.setSubject([{ name: 'commonName', value: host }])
    cert.setIssuer(this.caCert.subject.attributes)
    cert.setExtensions([
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      // See the CA's subjectKeyIdentifier above: this is the half Python
      // actually looks for.
      { name: 'subjectKeyIdentifier' },
      // keyIdentifier ONLY. The issuer+serial form (`authorityCertIssuer` +
      // `serialNumber`) is also legal ASN.1 but forge emits it in a shape
      // OpenSSL would not chain; the bare key id is what Python asks for.
      { name: 'authorityKeyIdentifier', keyIdentifier: this.caSubjectKeyId },
      {
        name: 'subjectAltName',
        // type 2 = dNSName, type 7 = iPAddress. A literal-IP destination needs
        // the iPAddress form; a dNSName of "1.2.3.4" does not match.
        altNames: [
          /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? { type: 7, ip: host } : { type: 2, value: host },
        ],
      },
    ])
    cert.sign(this.caKey, forge.md.sha256.create())

    const leaf: LeafCertificate = {
      certPem: forge.pki.certificateToPem(cert),
      keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    }
    this.cache.set(host, leaf)
    return leaf
  }
}
