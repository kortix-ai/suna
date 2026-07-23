import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createPortsRouter, parseProcNetTcp } from '../routes/ports'

const PROC_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12346 1 0000000000000000 100 0 0 10 0
   2: 0100007F:0016 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 12347 1 0000000000000000 100 0 0 10 0
`
// 0BB8=3000 LISTEN, 1F40=8000 LISTEN, 0016=22 ESTABLISHED(01)

describe('parseProcNetTcp', () => {
  it('returns LISTEN-state ports only, hex-decoded', () => {
    expect(parseProcNetTcp(PROC_TCP).sort((a, b) => a - b)).toEqual([3000, 8000])
  })
  it('tolerates garbage', () => {
    expect(parseProcNetTcp('')).toEqual([])
    expect(parseProcNetTcp('not\na\ntable')).toEqual([])
  })
})

describe('GET /ports', () => {
  const app = new Hono().route('/ports', createPortsRouter({
    excludedPorts: new Set([8000]),
    readProcFile: async (p) => (p.endsWith('tcp') ? PROC_TCP : ''),
  }))
  it('lists listening ports, excluding infra and <1024, ascending, deduped', async () => {
    const res = await app.request('/ports')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ports: [{ port: 3000 }] })
  })
  it('returns empty when proc files are unreadable', async () => {
    const bare = new Hono().route('/ports', createPortsRouter({
      excludedPorts: new Set(),
      readProcFile: async () => { throw new Error('ENOENT') },
    }))
    const res = await bare.request('/ports')
    expect(await res.json()).toEqual({ ports: [] })
  })
})

// One `/proc/net/tcp` LISTEN row for an arbitrary port — same column shape as
// PROC_TCP above (hex port, `st` 0A), built programmatically so every infra
// port under test gets its own realistic row instead of hand-hexed literals.
const PROC_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
function tcpListenRow(port: number): string {
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  return `   0: 00000000:${hex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0`
}
function procTextWithPorts(...ports: number[]): string {
  return [PROC_HEADER, ...ports.map(tcpListenRow)].join('\n')
}

describe('GET /ports — infra deny-list (W1)', () => {
  // Every port Jay observed leaking into the Preview card on a live session
  // (see INFRA_PORTS in ../routes/ports) must never surface, with zero extra
  // config from the route mount — the router excludes these on its own.
  it.each([2280, 22220, 22222, 33333])('excludes infra port %d even with no caller-provided excludedPorts', async (port) => {
    const app = new Hono().route('/ports', createPortsRouter({
      excludedPorts: new Set(),
      readProcFile: async (p) => (p.endsWith('tcp') ? procTextWithPorts(port) : ''),
    }))
    const res = await app.request('/ports')
    expect(await res.json()).toEqual({ ports: [] })
  })

  it('retains real app ports (4173, 3000) alongside an excluded infra port', async () => {
    const app = new Hono().route('/ports', createPortsRouter({
      excludedPorts: new Set(),
      readProcFile: async (p) => (p.endsWith('tcp') ? procTextWithPorts(4173, 3000, 2280) : ''),
    }))
    const res = await app.request('/ports')
    expect(await res.json()).toEqual({ ports: [{ port: 3000 }, { port: 4173 }] })
  })
})
