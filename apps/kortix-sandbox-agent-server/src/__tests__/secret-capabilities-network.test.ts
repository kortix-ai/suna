import { describe, expect, test } from 'bun:test'
import { renderSecretCapabilitiesInstruction } from '../secret-capabilities'

/**
 * The rendered file is injected as an OpenCode `instructions` file, so it is the
 * channel the model actually reads. An egress-enforced capability used to be
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
        environment_variable: 'STRIPE_KEY',
        hosts: ['api.stripe.com'],
        scheme: 'https',
        readable_in_sandbox: false,
        on_echo: 'redact',
      },
    ],
    notes: {
      network: [
        'The variable holds a HANDLE, not the value.',
        'A response that would echo the credential back comes back with `[REDACTED]` in its place.',
      ],
    },
    ...extra,
  })

describe('egress-enforced capabilities in the agent instructions', () => {
  test('names the identifier, its variable and its hosts instead of dropping the entry', () => {
    const md = renderSecretCapabilitiesInstruction(catalog())
    expect(md).toContain('STRIPE_KEY')
    expect(md).toContain('api.stripe.com')
    expect(md).toContain('handle')
  })

  test('does not claim an out-of-sandbox edge writes a header', () => {
    // There is ONE mechanism now (spec §4): the env var carries a handle and
    // Kortix substitutes the real value. The old copy named a header an edge
    // wrote, which described a mechanism that no longer serves any session and
    // told the agent to send a request it should not build itself.
    const md = renderSecretCapabilitiesInstruction(catalog())
    expect(md).not.toContain('network boundary')
    expect(md).not.toContain('adds the')
    expect(md).not.toContain('header to your HTTPS requests')
  })

  test('renders the rules the API authored, so the wording lives in one place', () => {
    const md = renderSecretCapabilitiesInstruction(catalog())
    expect(md).toContain('## Egress-enforced secrets')
    expect(md).toContain('- The variable holds a HANDLE, not the value.')
    expect(md).toContain('[REDACTED]')
  })

  test('accepts a string form too, so a shape change degrades to rendering', () => {
    const md = renderSecretCapabilitiesInstruction(catalog({ notes: { network: 'one line rule' } }))
    expect(md).toContain('- one line rule')
  })

  test('omits the rules block when no egress-enforced capability is granted', () => {
    const md = renderSecretCapabilitiesInstruction(
      JSON.stringify({
        version: 1,
        capabilities: [{ identifier: 'LOCAL', delivery: 'sandbox', environment_variable: 'LOCAL' }],
        notes: { network: ['should not appear'] },
      }),
    )
    expect(md).not.toContain('## Egress-enforced secrets')
    expect(md).not.toContain('should not appear')
    expect(md).toContain('`LOCAL`: sandbox environment variable `LOCAL`.')
  })

  test('drops a host that does not look like one', () => {
    const md = renderSecretCapabilitiesInstruction(
      JSON.stringify({
        version: 1,
        capabilities: [
          {
            identifier: 'BAD',
            delivery: 'network',
            environment_variable: 'BAD',
            hosts: ['api.ok.com', 'not a host', 'http://x.com'],
          },
        ],
      }),
    )
    expect(md).toContain('api.ok.com')
    expect(md).not.toContain('not a host')
    expect(md).not.toContain('http://x.com')
  })

  test('falls back to the identifier when no variable name came through', () => {
    const md = renderSecretCapabilitiesInstruction(
      JSON.stringify({
        version: 1,
        capabilities: [{ identifier: 'NO_VAR', delivery: 'network', hosts: ['api.ok.com'] }],
      }),
    )
    expect(md).toContain('`NO_VAR` holds a Kortix handle')
  })
})

/**
 * The usage rules are authored by the API and rendered here verbatim. There is
 * one symptom set now — `[REDACTED]` on a listed host means the substitution
 * worked — so this asserts the passthrough rather than any branching: a
 * renderer that dropped or rewrote these lines would leave the agent reading a
 * dead host as a working boundary.
 */
describe('echo notes reach the agent unchanged', () => {
  const withNotes = (network: string[]) =>
    JSON.stringify({
      version: 1,
      capabilities: [
        {
          identifier: 'BOUNDARY_ONE',
          delivery: 'network',
          environment_variable: 'BOUNDARY_ONE',
          hosts: ['api.example.com'],
        },
      ],
      notes: { network },
    })

  test('the redact wording survives rendering', () => {
    const out = renderSecretCapabilitiesInstruction(
      withNotes([
        'A response that would echo the value back into the sandbox comes back with `[REDACTED]` in its place.',
        'An empty reply or a connection error on a listed host is a REAL failure here. Do not read it as the boundary working.',
      ]),
    )
    expect(out).toContain('[REDACTED]')
    expect(out).toContain('is a REAL failure here')
  })

  test('the renderer does not invent echo guidance when the API sent none', () => {
    // The guest must not fill in usage rules the API withheld.
    const out = renderSecretCapabilitiesInstruction(
      JSON.stringify({
        version: 1,
        capabilities: [
          {
            identifier: 'B',
            delivery: 'network',
            environment_variable: 'B',
            hosts: ['api.example.com'],
          },
        ],
      }),
    )
    expect(out).not.toContain('[REDACTED]')
    expect(out).not.toContain('Empty reply from server')
  })
})
