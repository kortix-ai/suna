// A browser's side of Web Push for tests (KRTX-1742): its subscription keys,
// and the RFC 8291 decryption of an aes128gcm body the API sent it.
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';

export interface FakePushBrowser {
  p256dh: string;
  auth: string;
  decrypt(body: Uint8Array): string;
}

export function fakePushBrowser(): FakePushBrowser {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const derive = (ikm: Buffer, salt: Buffer, info: string | Buffer, length: number) =>
    Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info), length));
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: auth.toString('base64url'),
    decrypt(input) {
      const body = Buffer.from(input);
      const salt = body.subarray(0, 16);
      const idlen = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idlen);
      const record = body.subarray(21 + idlen);
      const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
      const ikm = derive(ecdh.computeSecret(asPublic), auth, keyInfo, 32);
      const decipher = createDecipheriv('aes-128-gcm', derive(ikm, salt, 'Content-Encoding: aes128gcm\0', 16), derive(ikm, salt, 'Content-Encoding: nonce\0', 12));
      decipher.setAuthTag(record.subarray(record.length - 16));
      const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
      if (padded[padded.length - 1] !== 2) throw new Error('not the last-record delimiter');
      return padded.subarray(0, padded.length - 1).toString();
    },
  };
}
