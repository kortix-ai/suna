import { afterEach, describe, expect, test } from 'bun:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import { runtimeManifestSigningPayload } from '@kortix/api-contract/runtime-manifest'
import { _resetRuntimeAssetsCache, runtimeAssetSigningPublicKey, runtimeAssetsManifest } from '../manifest'

const original = process.env.RUNTIME_ASSET_SIGNING_PRIVATE_KEY
afterEach(() => {
  if (original === undefined) delete process.env.RUNTIME_ASSET_SIGNING_PRIVATE_KEY
  else process.env.RUNTIME_ASSET_SIGNING_PRIVATE_KEY = original
  _resetRuntimeAssetsCache()
})

describe('runtime manifest signatures', () => {
  test('signs canonical manifest bytes with the configured Ed25519 key', async () => {
    const pair = generateKeyPairSync('ed25519')
    process.env.RUNTIME_ASSET_SIGNING_PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const manifest = await runtimeAssetsManifest()
    expect(manifest.signature?.algorithm).toBe('ed25519')
    const publicPem = runtimeAssetSigningPublicKey()!
    expect(verify(null, Buffer.from(runtimeManifestSigningPayload(manifest as unknown as Record<string, unknown>)), publicPem, Buffer.from(manifest.signature!.value, 'base64'))).toBe(true)
  })

  test('reports null signature when self-host has no signing key', async () => {
    delete process.env.RUNTIME_ASSET_SIGNING_PRIVATE_KEY
    expect((await runtimeAssetsManifest()).signature).toBeNull()
  })
})
