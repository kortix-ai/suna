// Which pages the voice's call browser opens (host.ts callLink): a public site's https page; never the box itself, a
// private network, or plain http; a Google Meet link joins as a meeting instead. No browser.
import { expect, test } from 'bun:test'
import { callLink } from './host'

test('a public https call page opens', () => {
  expect(typeof callLink('https://meet.jit.si/TeamStandup')).not.toBe('string')
  expect(typeof callLink('https://whereby.com/acme')).not.toBe('string')
})

test('the box, private names, IP literals and plain http do not', () => {
  for (const url of ['http://meet.jit.si/x', 'https://localhost:8000/', 'https://127.0.0.1/', 'https://[::1]/', 'https://kortixd/', 'https://box.internal/', 'https://printer.local/', 'file:///etc/passwd', 'not a link'])
    expect(typeof callLink(url)).toBe('string')
})

test('a Google Meet link goes to voice_join_meet', () => {
  expect(String(callLink('https://meet.google.com/abc-defg-hij'))).toContain('voice_join_meet')
})

test('the call browser loads only names whose every address is public: no literal, no IPv6 carrying a private IPv4', async () => {
  const { publicHost } = await import('./call')
  const at = (addr: string) => publicHost('v6.example', async () => [addr])
  expect(await publicHost('[::ffff:7f00:1]', async () => [])).toBe(false)
  expect(await publicHost('93.184.216.34', async () => [])).toBe(false)
  for (const a of ['::ffff:7f00:1', '::ffff:127.0.0.1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', 'fe80::1', '::1', 'fd00::5', '127.0.0.1', '10.1.2.3', '169.254.169.254']) expect(await at(a)).toBe(false)
  expect(await at('2606:4700::6810:84e5')).toBe(true)
  expect(await at('93.184.216.34')).toBe(true)
})
