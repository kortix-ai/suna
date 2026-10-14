//! Client-side encryption of synced objects (`sync.encrypt`).
//!
//! Format `KCE1`: `b"KCE1"` | key id (8 bytes) | nonce prefix (7 bytes) |
//! segments. Each segment is up to 1 MiB of plaintext sealed with AES-256-GCM
//! (STREAM construction, big-endian 32-bit counter plus a last-segment flag),
//! so a file of any size encrypts and decrypts in constant memory, and a
//! truncated, reordered or altered object fails to decrypt. The header is the
//! associated data of every segment.
//!
//! The 32-byte key is generated locally and kept in the OS secret store
//! (service `ai.kortix.capture.sync`, account = key id; see
//! [`crate::secret_store`]), or `<library>/sync-key` (mode 0600) when that store
//! is unavailable. `KORTIX_CAPTURE_KEY_STORE=file` forces the file. Losing the
//! key makes every encrypted object unreadable.

use super::super::paths::MemoryPaths;
use aes_gcm::{
    aead::{
        stream::{DecryptorBE32, EncryptorBE32},
        OsRng, Payload,
    },
    aes::cipher::generic_array::GenericArray,
    Aes256Gcm, KeyInit,
};
use anyhow::{bail, Context, Result};
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const MAGIC: &[u8; 4] = b"KCE1";
const HEADER_LEN: usize = 4 + 8 + 7;
const SEGMENT: usize = 1024 * 1024;
const TAG: usize = 16;
pub const ALG: &str = "AES-256-GCM/STREAM-BE32/1MiB";
const KEYCHAIN_SERVICE: &str = "ai.kortix.capture.sync";
pub const KEY_STORE_ENV: &str = crate::secret_store::STORE_ENV;

#[derive(Clone)]
pub struct Key([u8; 32]);

impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Key({})", self.id())
    }
}

impl Key {
    pub fn generate() -> Self {
        Self(Aes256Gcm::generate_key(OsRng).into())
    }

    pub fn from_b64(s: &str) -> Result<Self> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(s.trim())
            .context("the key is not base64")?;
        let arr: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("the key must be 32 bytes"))?;
        Ok(Self(arr))
    }

    pub fn to_b64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.0)
    }

    fn id_bytes(&self) -> [u8; 8] {
        let d = Sha256::digest([b"kortix-capture-key-id:".as_slice(), &self.0].concat());
        d[..8].try_into().unwrap()
    }

    /// Public fingerprint of the key (16 hex chars); safe to store and print.
    pub fn id(&self) -> String {
        super::s3::hex(&self.id_bytes())
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(GenericArray::from_slice(&self.0))
    }
}

pub fn is_encrypted(bytes: &[u8]) -> bool {
    bytes.starts_with(MAGIC)
}

/// Key id in an encrypted object's header.
pub fn key_id_of(bytes: &[u8]) -> Option<String> {
    (bytes.len() >= HEADER_LEN && is_encrypted(bytes)).then(|| super::s3::hex(&bytes[4..12]))
}

/// Fill `buf` as far as the reader allows; returns the bytes read.
fn fill(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

pub fn encrypt(key: &Key, mut input: impl Read, mut out: impl Write) -> Result<()> {
    let mut prefix = [0u8; 7];
    aes_gcm::aead::rand_core::RngCore::fill_bytes(&mut OsRng, &mut prefix);
    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(MAGIC);
    header.extend_from_slice(&key.id_bytes());
    header.extend_from_slice(&prefix);
    out.write_all(&header)?;
    let mut enc = EncryptorBE32::from_aead(key.cipher(), GenericArray::from_slice(&prefix));
    let (mut cur, mut next) = (vec![0u8; SEGMENT], vec![0u8; SEGMENT]);
    let mut cur_len = fill(&mut input, &mut cur)?;
    loop {
        let next_len = if cur_len == SEGMENT {
            fill(&mut input, &mut next)?
        } else {
            0
        };
        let payload = Payload {
            msg: &cur[..cur_len],
            aad: &header,
        };
        if next_len == 0 {
            let sealed = enc
                .encrypt_last(payload)
                .map_err(|_| anyhow::anyhow!("encrypt failed"))?;
            out.write_all(&sealed)?;
            break;
        }
        let sealed = enc
            .encrypt_next(payload)
            .map_err(|_| anyhow::anyhow!("encrypt failed"))?;
        out.write_all(&sealed)?;
        std::mem::swap(&mut cur, &mut next);
        cur_len = next_len;
    }
    out.flush()?;
    Ok(())
}

pub fn decrypt(key: &Key, mut input: impl Read, mut out: impl Write) -> Result<()> {
    let mut header = [0u8; HEADER_LEN];
    if fill(&mut input, &mut header)? < HEADER_LEN || &header[..4] != MAGIC {
        bail!("not an encrypted capture object");
    }
    if header[4..12] != key.id_bytes() {
        bail!(
            "object is encrypted with key {}, the local key is {} (import the right key with `kortix-capture sync key import`)",
            super::s3::hex(&header[4..12]),
            key.id()
        );
    }
    let mut dec = DecryptorBE32::from_aead(key.cipher(), GenericArray::from_slice(&header[12..]));
    let (mut cur, mut next) = (vec![0u8; SEGMENT + TAG], vec![0u8; SEGMENT + TAG]);
    let mut cur_len = fill(&mut input, &mut cur)?;
    loop {
        let next_len = if cur_len == SEGMENT + TAG {
            fill(&mut input, &mut next)?
        } else {
            0
        };
        let payload = Payload {
            msg: &cur[..cur_len],
            aad: &header,
        };
        if next_len == 0 {
            let plain = dec.decrypt_last(payload).map_err(|_| {
                anyhow::anyhow!("decrypt failed: the object is corrupt or truncated")
            })?;
            out.write_all(&plain)?;
            break;
        }
        let plain = dec
            .decrypt_next(payload)
            .map_err(|_| anyhow::anyhow!("decrypt failed: the object is corrupt"))?;
        out.write_all(&plain)?;
        std::mem::swap(&mut cur, &mut next);
        cur_len = next_len;
    }
    out.flush()?;
    Ok(())
}

pub fn encrypt_bytes(key: &Key, plain: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(plain.len() + HEADER_LEN + TAG * (plain.len() / SEGMENT + 1));
    encrypt(key, plain, &mut out)?;
    Ok(out)
}

pub fn decrypt_bytes(key: &Key, sealed: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(sealed.len());
    decrypt(key, sealed, &mut out)?;
    Ok(out)
}

/// Encrypt `src` into `dst` (written via `dst.part`, then renamed).
pub fn encrypt_file(key: &Key, src: &Path, dst: &Path) -> Result<()> {
    if let Some(dir) = dst.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let part = dst.with_extension("part");
    {
        let input = std::io::BufReader::new(
            std::fs::File::open(src).with_context(|| format!("open {}", src.display()))?,
        );
        let out = std::io::BufWriter::new(std::fs::File::create(&part)?);
        encrypt(key, input, out)?;
    }
    std::fs::rename(&part, dst)?;
    Ok(())
}

/// Decrypt `src` into `dst` (written via `dst.part`, then renamed).
pub fn decrypt_file(key: &Key, src: &Path, dst: &Path) -> Result<()> {
    let part = dst.with_extension("dec.part");
    let res = (|| {
        let input = std::io::BufReader::new(std::fs::File::open(src)?);
        let out = std::io::BufWriter::new(std::fs::File::create(&part)?);
        decrypt(key, input, out)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    res?;
    std::fs::rename(&part, dst)?;
    Ok(())
}

// ---- key storage ----

fn key_file(paths: &MemoryPaths) -> PathBuf {
    paths.root.join("sync-key")
}

/// The key with this id, from the OS secret store or the key file.
pub fn load(paths: &MemoryPaths, key_id: &str) -> Option<Key> {
    if key_id.is_empty() {
        return None;
    }
    crate::secret_store::get(KEYCHAIN_SERVICE, key_id, &key_file(paths))
        .and_then(|text| Key::from_b64(&text).ok())
        .filter(|k| k.id() == key_id)
}

/// Store a key; returns where it went (see [`crate::secret_store::put`]).
pub fn store(paths: &MemoryPaths, key: &Key) -> Result<&'static str> {
    crate::secret_store::put(
        KEYCHAIN_SERVICE,
        &key.id(),
        "Kortix Capture sync key",
        &key.to_b64(),
        &key_file(paths),
    )
}

/// Delete the stored key `key_id` (tests and key rotation).
pub fn forget(paths: &MemoryPaths, key_id: &str) {
    crate::secret_store::delete(KEYCHAIN_SERVICE, key_id, &key_file(paths));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_size_class() {
        let key = Key::generate();
        for len in [
            0,
            1,
            1000,
            SEGMENT - 1,
            SEGMENT,
            SEGMENT + 1,
            2 * SEGMENT,
            2 * SEGMENT + 17,
        ] {
            let plain: Vec<u8> = (0..len).map(|i| (i * 31 % 251) as u8).collect();
            let sealed = encrypt_bytes(&key, &plain).unwrap();
            assert!(is_encrypted(&sealed));
            assert_eq!(key_id_of(&sealed).unwrap(), key.id());
            let segs = len / SEGMENT + usize::from(len % SEGMENT != 0 || len == 0);
            assert_eq!(sealed.len(), HEADER_LEN + len + segs * TAG, "len {len}");
            assert_eq!(decrypt_bytes(&key, &sealed).unwrap(), plain, "len {len}");
        }
    }

    #[test]
    fn tamper_truncation_and_wrong_key_fail() {
        let key = Key::generate();
        let plain = vec![7u8; SEGMENT + 500];
        let sealed = encrypt_bytes(&key, &plain).unwrap();
        let mut flipped = sealed.clone();
        flipped[HEADER_LEN + 10] ^= 1;
        assert!(
            decrypt_bytes(&key, &flipped).is_err(),
            "a flipped bit fails"
        );
        assert!(
            decrypt_bytes(&key, &sealed[..HEADER_LEN + SEGMENT + TAG]).is_err(),
            "dropping the last segment fails"
        );
        let other = Key::generate();
        let err = decrypt_bytes(&other, &sealed).unwrap_err().to_string();
        assert!(err.contains("encrypted with key"), "{err}");
        // Same plaintext, fresh nonce prefix: different ciphertext.
        assert_ne!(encrypt_bytes(&key, &plain).unwrap(), sealed);
    }

    #[test]
    fn key_encodes_and_has_a_stable_id() {
        let key = Key::generate();
        let again = Key::from_b64(&key.to_b64()).unwrap();
        assert_eq!(again.id(), key.id());
        assert_eq!(key.id().len(), 16);
        assert!(Key::from_b64("c2hvcnQ=").is_err());
    }

    #[test]
    fn file_store_round_trips() {
        std::env::set_var(KEY_STORE_ENV, "file");
        let dir = std::env::temp_dir().join(format!("kcap-key-{}", uuid::Uuid::new_v4().simple()));
        let paths = MemoryPaths::at(&dir);
        paths.ensure().unwrap();
        let key = Key::generate();
        assert_eq!(store(&paths, &key).unwrap(), "file");
        assert_eq!(load(&paths, &key.id()).unwrap().id(), key.id());
        assert!(
            load(&paths, "0000000000000000").is_none(),
            "a different id does not load"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(key_file(&paths))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
