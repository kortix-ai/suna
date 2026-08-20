/**
 * The certificate extensions, pinned because a missing one is invisible until a
 * specific client rejects the chain in a real guest.
 *
 * Found the hard way: without the key-identifier pair, `curl` accepted the
 * certificate and `python3 -m requests` refused it with
 * `CERTIFICATE_VERIFY_FAILED ... Missing Authority Key Identifier`. Measured in
 * a real Daytona sandbox — every local test passed while Python was broken for
 * every agent that would have used it.
 */
import { describe, expect, test } from 'bun:test'
import net from 'node:net'
import tls from 'node:tls'
import forge from 'node-forge'
import { X509Certificate } from 'node:crypto'
import { createEphemeralCa, LeafIssuer, serialFromBytes } from './ca'

const ca = createEphemeralCa('test')
const leaf = new LeafIssuer(ca).issue('api.example.com')
const parse = (pem: string) => forge.pki.certificateFromPem(pem)

describe('the chain carries the identifiers strict clients demand', () => {
  test('the CA publishes a Subject Key Identifier', () => {
    // An AKI can only reference a SKI that exists on the issuer, so this is the
    // half that makes the leaf's reference resolvable.
    expect(parse(ca.certPem).getExtension('subjectKeyIdentifier')).toBeTruthy()
  })

  test('the leaf carries BOTH its own SKI and an Authority Key Identifier', () => {
    const cert = parse(leaf.certPem)
    expect(cert.getExtension('subjectKeyIdentifier')).toBeTruthy()
    expect(cert.getExtension('authorityKeyIdentifier')).toBeTruthy()
  })

  test("the leaf's AKI actually matches the CA's key id", () => {
    // A present-but-wrong AKI is worse than none: it points the verifier at an
    // issuer that does not exist. The first fix emitted exactly that and every
    // TLS handshake failed with "unable to verify the first certificate".
    const caKeyId = parse(ca.certPem).generateSubjectKeyIdentifier().getBytes()
    const aki = parse(leaf.certPem).getExtension('authorityKeyIdentifier') as
      | { value?: string }
      | undefined
    expect(aki?.value).toContain(caKeyId)
  })
})

describe('a real TLS client verifies the chain', () => {
  test('handshake succeeds and reports authorized', async () => {
    // The end-to-end assertion the extension checks above only approximate.
    const server = tls.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (s) => s.end('ok'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as net.AddressInfo).port
    const authorized = await new Promise<boolean>((resolve) => {
      const c = tls.connect(
        { port, host: '127.0.0.1', servername: 'api.example.com', ca: ca.certPem },
        () => {
          const ok = c.authorized
          c.destroy()
          resolve(ok)
        },
      )
      c.on('error', () => resolve(false))
    })
    server.close()
    expect(authorized).toBe(true)
  })
})

/**
 * The serial number, as DER actually defines it.
 *
 * Found by a 1-in-256 flake in `shim.test.ts`: a handshake would fail with
 * `BoringSSL ... ASN.1 encoding routines ... INVALID_INTEGER`, and
 * `openssl asn1parse` on the offending certificate read
 *
 *   13:d=2  hl=2 l=16 prim: INTEGER :BAD INTEGER:[001693B07CCB2713BECB33E5B5FABCEA]
 *
 * `openssl x509` could not load the certificate at all. The serial was built as
 * `'00' + randomBytes(16)`, where the leading `00` was meant to keep the value
 * positive. DER INTEGERs must also be MINIMAL: a `0x00` prefix is legal only
 * when the next byte is >= 0x80. When the first random byte happened to be
 * below that the zero was redundant, and roughly once in 256 sandboxes the shim
 * minted a CA no client could parse.
 *
 * These cases are the encoding rule itself, not a sample of it — a probabilistic
 * test for a 1-in-256 fault is a test that passes while the bug ships.
 */
describe('the serial number is a minimal, positive DER INTEGER', () => {
  // Filler with the high bit CLEAR, which is what makes a leading zero
  // redundant rather than required. High-bit-set filler hides the fault: forge
  // then re-adds a zero the encoding genuinely needs and the result is valid.
  const bytes = (first: number) => Uint8Array.from([first, ...new Array(15).fill(0x16)])

  /** The serial `openssl asn1parse` reported as `BAD INTEGER`, byte for byte. */
  const CAPTURED = Uint8Array.from([
    0x00, 0x16, 0x93, 0xb0, 0x7c, 0xcb, 0x27, 0x13,
    0xbe, 0xcb, 0x33, 0xe5, 0xb5, 0xfa, 0xbc, 0xea,
  ])

  test('a first byte of 0x00 does not become a redundant leading zero', () => {
    // The exact fault: `00 00 ab …` — a leading zero followed by a byte whose
    // high bit is clear. This is the case that shipped.
    const hex = serialFromBytes(bytes(0x00))
    expect(hex.startsWith('00')).toBe(false)
  })

  test('no first byte at all produces a leading zero', () => {
    // 0x01..0x7f is the whole legal range for a minimal positive leading byte.
    for (let first = 0; first <= 0xff; first++) {
      const lead = Number.parseInt(serialFromBytes(bytes(first)).slice(0, 2), 16)
      expect(lead).toBeGreaterThan(0x00)
      expect(lead).toBeLessThan(0x80)
    }
  })

  test('an empty input still yields a byte — a zero-length INTEGER is invalid too', () => {
    // Unreachable from `serial()`, which always passes 16 bytes. Pinned so the
    // function cannot quietly grow a second way to emit malformed DER.
    const hex = serialFromBytes(new Uint8Array(0))
    expect(hex.length).toBeGreaterThan(0)
    const lead = Number.parseInt(hex.slice(0, 2), 16)
    expect(lead).toBeGreaterThan(0x00)
    expect(lead).toBeLessThan(0x80)
  })

  test('every serial keeps well over the 64 bits of entropy a serial owes', () => {
    // Clamping the leading byte costs one bit, not the field. CA/Browser Forum
    // asks for >= 64 bits; this keeps ~127.
    expect(serialFromBytes(bytes(0x00)).length / 2).toBeGreaterThanOrEqual(16)
  })

  test('a certificate built from the worst-case serial actually loads', () => {
    // The encoder rule above, proved through the thing it exists for: OpenSSL
    // parsing a real certificate built from the exact bytes that failed.
    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = serialFromBytes(CAPTURED)
    cert.validity.notBefore = new Date(Date.now() - 60_000)
    cert.validity.notAfter = new Date(Date.now() + 3_600_000)
    const attrs = [{ name: 'commonName', value: 'serial-probe' }]
    cert.setSubject(attrs)
    cert.setIssuer(attrs)
    cert.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }])
    cert.sign(keys.privateKey, forge.md.sha256.create())

    const pem = forge.pki.certificateToPem(cert)
    expect(() => new X509Certificate(pem)).not.toThrow()
    // And the strict path the flake actually failed on.
    expect(() => tls.createSecureContext({ ca: pem })).not.toThrow()
  })
})
