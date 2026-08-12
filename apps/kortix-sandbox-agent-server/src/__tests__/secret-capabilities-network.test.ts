import { describe, expect, test } from 'bun:test'
import { renderSecretCapabilitiesInstruction } from '../secret-capabilities'

/**
 * The rendered file is injected as an OpenCode `instructions` file, so it is the
 * channel the model actually reads. A network-boundary capability used to be
 * dropped here entirely — the renderer allow-listed three delivery values — and
 * the result was an agent that hit the boundary's echo cut, concluded the host
 * was broken, and invented a reason.
 */
const catalog = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    capabilities: [
      {
        identifier: 'STRIPE_KEY',
        delivery: 'network',
        hosts: ['api.stripe.com'],
        header: 'authorization',
        scheme: 'https',
        readable_in_sandbox: false,
        on_echo: 'block',
      },
    ],
    notes: { network: ['Send an ordinary request.', 'curl: (52) Empty reply means it worked.'] },
    ...extra,
  })

describe('network-boundary capabilities in the agent instructions', () => {
  test('names the host and the header instead of dropping the entry', () => {
    const md = renderSecretCapabilitiesInstruction(catalog())
    expect(md).toContain('STRIPE_KEY')
    expect(md).toContain('api.stripe.com')
    expect(md).toContain('authorization')
  })

  test('renders the rules the API authored, so the wording lives in one place', () => {
    const md = renderSecretCapabilitiesInstruction(catalog())
    expect(md).toContain('## Network boundary')
    expect(md).toContain('- Send an ordinary request.')
    expect(md).toContain('curl: (52) Empty reply means it worked.')
  })

  test('accepts a string form too, so a shape change degrades to rendering', () => {
    const md = renderSecretCapabilitiesInstruction(catalog({ notes: { network: 'one line rule' } }))
    expect(md).toContain('- one line rule')
  })

  test('omits the rules block when no network capability is granted', () => {
    const md = renderSecretCapabilitiesInstruction(
      JSON.stringify({
        version: 1,
        capabilities: [{ identifier: 'LOCAL', delivery: 'sandbox', environment_variable: 'LOCAL' }],
        notes: { network: ['should not appear'] },
      }),
    )
    expect(md).not.toContain('## Network boundary')
    expect(md).not.toContain('should not appear')
    expect(md).toContain('`LOCAL`: sandbox environment variable `LOCAL`.')
  })

  test('drops a host or header that does not look like one', () => {
    const md = renderSecretCapabilitiesInstruction(
      JSON.stringify({
        version: 1,
        capabilities: [
          {
            identifier: 'BAD',
            delivery: 'network',
            hosts: ['api.ok.com', 'not a host', 'http://x.com'],
            header: 'auth orization',
          },
        ],
      }),
    )
    expect(md).toContain('api.ok.com')
    expect(md).not.toContain('not a host')
    expect(md).not.toContain('http://x.com')
    // an unusable header name falls back rather than echoing junk into the prompt
    expect(md).toContain('`authorization`')
  })
})
