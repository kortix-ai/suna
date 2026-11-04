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
