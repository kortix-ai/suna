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
import { createEphemeralCa, LeafIssuer } from './ca'

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
