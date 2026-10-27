import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test'
import { createWebProxyRouter } from '@/routes/proxy/web-proxy'

let addresses = [{ address: '93.184.216.34', family: 4 }]
const lookup = mock(async () => addresses)
mock.module('node:dns/promises', () => ({ lookup }))
const fetchSpy = spyOn(globalThis, 'fetch')
afterEach(() => {
  fetchSpy.mockReset()
  lookup.mockClear()
  addresses = [{ address: '93.184.216.34', family: 4 }]
})
afterAll(() => fetchSpy.mockRestore())

const app = createWebProxyRouter()

test.each([
  '127.0.0.1:3000', '127.1:80', '10.0.0.1:443', '172.16.0.1:8080',
  '192.168.0.1:80', '169.254.169.254:80', '100.64.0.1:80',
  '[::1]:80', '[fe80::1]:80', '[fd00:ec2::254]:80', '[::ffff:127.0.0.1]:80',
])('denies non-public destination %s without fetching', async (host) => {
  fetchSpy.mockResolvedValue(new Response('synthetic upstream'))
  const response = await app.request(`/web-proxy/http/${host}/`)
  expect(response.status).toBe(403)
  expect(fetchSpy).not.toHaveBeenCalled()
})

test('rejects DNS with any private answer on any port', async () => {
  addresses.push({ address: '10.0.0.1', family: 4 })
  const response = await app.request('/web-proxy/https/upstream.example:8443/')
  expect(response.status).toBe(403)
  expect(fetchSpy).not.toHaveBeenCalled()
})

test('fails closed when DNS fails or returns no addresses', async () => {
  lookup.mockRejectedValueOnce(new Error('synthetic lookup failure'))
  expect((await app.request('/web-proxy/http/upstream.example/')).status).toBe(403)
  addresses = []
  expect((await app.request('/web-proxy/http/upstream.example/')).status).toBe(403)
  expect(fetchSpy).not.toHaveBeenCalled()
})

test.each(['http', 'https'])('pins %s DNS, preserves Host and strips caller credentials', async (scheme) => {
  fetchSpy.mockResolvedValue(new Response('ok'))
  const response = await app.request(`/web-proxy/${scheme}/upstream.example:8443/asset`, {
    headers: {
      authorization: 'Bearer synthetic-key', cookie: 'synthetic=value',
      'proxy-authorization': 'synthetic', 'x-kortix-user-context': 'synthetic',
      'x-kortix-service-call': '1', 'x-daytona-preview-token': 'synthetic',
      'accept-language': 'en-GB',
    },
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('ok')
  expect(lookup).toHaveBeenCalledTimes(1)
  const call = fetchSpy.mock.calls[0]
  expect(call?.[0]).toBe(`${scheme}://93.184.216.34:8443/asset`)
  const headers = new Headers(call?.[1]?.headers)
  expect(headers.get('host')).toBe('upstream.example:8443')
  expect(headers.get('accept-language')).toBe('en-GB')
  expect([...headers.values()].join(' ')).not.toContain('synthetic-key')
  for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-kortix-user-context', 'x-kortix-service-call', 'x-daytona-preview-token']) {
    expect(headers.has(name)).toBe(false)
  }
  expect(call?.[1]).toMatchObject({ redirect: 'manual', ...(scheme === 'https' ? { tls: { serverName: 'upstream.example' } } : {}) })
})

test.each(['http://169.254.169.254/', 'http://[fd00:ec2::254]/', 'file:///synthetic', '//internal.example/'])('denies an unsafe redirect %s', async (location) => {
  fetchSpy.mockImplementation(Object.assign(async () => {
    addresses = [{ address: '10.0.0.1', family: 4 }]
    return new Response(null, { status: 302, headers: { location } })
  }, { preconnect: globalThis.fetch.preconnect }))
  const response = await app.request('/web-proxy/https/upstream.example/')
  expect(response.status).toBe(403)
  expect(response.headers.has('location')).toBe(false)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
})

test('rewrites public redirects and rechecks DNS when the browser follows', async () => {
  fetchSpy.mockResolvedValue(new Response(null, { status: 302, headers: { location: '/next' } }))
  const response = await app.request('/web-proxy/https/upstream.example/start')
  expect(response.status).toBe(302)
  expect(response.headers.get('location')).toBe('/web-proxy/https/upstream.example/next')
  addresses = [{ address: '127.0.0.1', family: 4 }]
  const next = await app.request(response.headers.get('location') ?? '')
  expect(next.status).toBe(403)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
})

test.each(['0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0'])('rejects expanded DNS IPv6 %s', async (address) => {
  addresses = [{ address, family: 6 }]
  expect((await app.request('/web-proxy/http/upstream.example/')).status).toBe(403)
  expect(fetchSpy).not.toHaveBeenCalled()
})

test('drops response-header navigation outside the proxy', async () => {
  fetchSpy.mockResolvedValue(new Response('ok', { headers: { refresh: '0; url=http://internal.example/' } }))
  const response = await app.request('/web-proxy/https/upstream.example/')
  expect(response.status).toBe(200)
  expect(response.headers.has('refresh')).toBe(false)
})

test('each public redirect hop pins its own host before denying the private hop', async () => {
  fetchSpy.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://second.example/next' } }))
  const first = await app.request('/web-proxy/https/upstream.example/')
  expect(first.status).toBe(302)
  addresses = [{ address: '93.184.216.35', family: 4 }]
  fetchSpy.mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: 'http://10.0.0.1/' } }))
  const second = await app.request(first.headers.get('location') ?? '', { headers: { authorization: 'Bearer synthetic-key' } })
  expect(second.status).toBe(403)
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  expect(fetchSpy.mock.calls[1]?.[0]).toBe('https://93.184.216.35/next')
  const headers = new Headers(fetchSpy.mock.calls[1]?.[1]?.headers)
  expect(headers.get('host')).toBe('second.example')
  expect(headers.has('authorization')).toBe(false)
})
