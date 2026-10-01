//! SQLite store for Kortix Capture.
//!
//! Tables: application, domain, video, segment, frame, ocr, window_bound,
//! ocr_fts (FTS5 over frame text), ax_blob/ax_snapshot, timezone, app_version,
//! metadata.

use super::paths::MemoryPaths;
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::time::Duration;

pub const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS application (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_id TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '',
    icon_path TEXT,
    display_name TEXT,
    is_user_app INTEGER,
    dominant_color INTEGER,
    UNIQUE(bundle_id, version)
);
CREATE INDEX IF NOT EXISTS idx_application_bundle_id ON application(bundle_id);

CREATE TABLE IF NOT EXISTS domain (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    normalized_domain TEXT NOT NULL UNIQUE,
    common_name TEXT,
    icon_path TEXT,
    dominant_color INTEGER
);

CREATE TABLE IF NOT EXISTS video (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    height INTEGER NOT NULL,
    width INTEGER NOT NULL,
    path TEXT NOT NULL,
    num_frames INTEGER NOT NULL,
    status INTEGER NOT NULL DEFAULT 0,          -- 0 full, 1 downscaled, 2 deleted
    size_bytes INTEGER,
    start_timestamp INTEGER,                    
    end_timestamp INTEGER                       
);
CREATE INDEX IF NOT EXISTS idx_video_start ON video(start_timestamp);

CREATE TABLE IF NOT EXISTS segment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_frame_id INTEGER NOT NULL,
    application INTEGER REFERENCES application(id),
    domain INTEGER REFERENCES domain(id),
    url TEXT
);
CREATE INDEX IF NOT EXISTS idx_segment_application ON segment(application);
CREATE INDEX IF NOT EXISTS idx_segment_domain ON segment(domain);

CREATE TABLE IF NOT EXISTS frame (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,                 -- epoch ms
    video INTEGER REFERENCES video(id),
    video_index INTEGER,
    image_path TEXT,                            -- staged still until encoded
    width INTEGER,
    height INTEGER,
    foreground TEXT,                            -- OCR text inside the focused window
    background TEXT,                            -- OCR text elsewhere
    title TEXT,
    tree BLOB,
    segment INTEGER REFERENCES segment(id),
    is_inactive INTEGER NOT NULL DEFAULT 0,
    ax_root_hash BLOB,
    capture_display_x REAL,
    capture_display_y REAL,
    capture_display_width REAL,
    capture_display_height REAL,
    capture_reason TEXT,
    dhash TEXT,                                 -- perceptual hash
    image_hash TEXT,                            -- sha256 of the staged still
    ocr_status INTEGER NOT NULL DEFAULT 0       -- 0 pending, 1 done, 2 copied, 3 failed
);
CREATE INDEX IF NOT EXISTS idx_frame_timestamp ON frame(timestamp);
CREATE INDEX IF NOT EXISTS idx_frame_segment ON frame(segment);
CREATE INDEX IF NOT EXISTS idx_frame_video ON frame(video);
CREATE INDEX IF NOT EXISTS idx_frame_ocr_pending ON frame(id) WHERE ocr_status = 0;
CREATE INDEX IF NOT EXISTS idx_frame_unfinalized ON frame(id, image_path) WHERE video IS NULL AND image_path IS NOT NULL;

-- Boxes index into (foreground || background): text_offset >= length(foreground)
-- means the box belongs to the background text.
CREATE TABLE IF NOT EXISTS ocr (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    frame INTEGER NOT NULL REFERENCES frame(id),
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    text_offset INTEGER NOT NULL,
    text_length INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ocr_frame ON ocr(frame);

CREATE TABLE IF NOT EXISTS window_bound (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    frame INTEGER NOT NULL REFERENCES frame(id),
    application INTEGER NOT NULL REFERENCES application(id),
    window_title TEXT,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    window_layer INTEGER NOT NULL DEFAULT 0,
    z_order INTEGER NOT NULL DEFAULT 0,
    url TEXT,
    is_focussed_window INTEGER
);
CREATE INDEX IF NOT EXISTS idx_window_bound_frame ON window_bound(frame);

CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS timezone (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier TEXT NOT NULL,
    observed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_version (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    observed_at INTEGER NOT NULL
);

-- accessibility trees, deduplicated by content hash.
CREATE TABLE IF NOT EXISTS ax_blob (
    hash BLOB PRIMARY KEY,
    payload BLOB NOT NULL                       -- zstd(JSON tree)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ax_snapshot (
    frame_id INTEGER PRIMARY KEY REFERENCES frame(id) ON DELETE CASCADE,
    hash BLOB NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    application_name TEXT NOT NULL,
    bundle_id TEXT NOT NULL,
    process_identifier INTEGER NOT NULL,
    node_count INTEGER NOT NULL DEFAULT 0,
    is_partial_tree INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS ocr_fts USING fts5(
    foreground,
    background,
    title,
    content='frame',
    content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS frame_ai AFTER INSERT ON frame BEGIN
    INSERT INTO ocr_fts(rowid, foreground, background, title)
    VALUES (new.id, new.foreground, new.background, new.title);
END;
CREATE TRIGGER IF NOT EXISTS frame_ad AFTER DELETE ON frame BEGIN
    INSERT INTO ocr_fts(ocr_fts, rowid, foreground, background, title)
    VALUES('delete', old.id, old.foreground, old.background, old.title);
END;
CREATE TRIGGER IF NOT EXISTS frame_au AFTER UPDATE ON frame
WHEN OLD.foreground IS NOT NEW.foreground
  OR OLD.background IS NOT NEW.background
  OR OLD.title IS NOT NEW.title
BEGIN
    INSERT INTO ocr_fts(ocr_fts, rowid, foreground, background, title)
    VALUES('delete', old.id, old.foreground, old.background, old.title);
    INSERT INTO ocr_fts(rowid, foreground, background, title)
    VALUES (new.id, new.foreground, new.background, new.title);
END;
"#;

fn configure(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(10))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

/// Read-write connection; creates and migrates the schema.
pub fn open(paths: &MemoryPaths) -> Result<Connection> {
    paths.ensure()?;
    let conn = Connection::open(paths.db()).with_context(|| format!("open {}", paths.db().display()))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

/// Read-only connection for queries (CLI). Works while the recorder writes.
pub fn open_readonly(paths: &MemoryPaths) -> Result<Connection> {
    let db = paths.db();
    if !db.exists() {
        anyhow::bail!(
            "no capture library at {} (start recording with `kortix-capture record`)",
            db.display()
        );
    }
    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .with_context(|| format!("open {}", db.display()))?;
    configure(&conn)?;
    Ok(conn)
}

pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)?;
    // Columns added after a table first shipped.
    for (table, column, decl) in [
        ("frame", "dhash", "TEXT"),
        ("frame", "image_hash", "TEXT"),
        ("frame", "ocr_status", "INTEGER NOT NULL DEFAULT 1"),
        ("video", "start_timestamp", "INTEGER"),
        ("video", "end_timestamp", "INTEGER"),
        ("video", "uploaded_at", "INTEGER"),           // epoch ms of the committed upload
        ("video", "upload_attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("video", "upload_error", "TEXT"),
    ] {
        if !has_column(conn, table, column)? {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))?;
        }
    }
    set_meta(conn, "schema_version", &SCHEMA_VERSION.to_string())?;
    Ok(())
}

pub fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO metadata(key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now_ms()],
    )?;
    Ok(())
}

pub fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM metadata WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

/// `https://www.Example.com/a` -> `example.com`. None for non-web URLs.
pub fn normalize_domain(url: &str) -> Option<String> {
    let rest = url.split_once("://").map(|(scheme, rest)| (scheme.to_ascii_lowercase(), rest))?;
    if rest.0 != "http" && rest.0 != "https" {
        return None;
    }
    let host_port = rest.1.split(['/', '?', '#']).next()?;
    let host = host_port.rsplit_once('@').map(|(_, h)| h).unwrap_or(host_port);
    let host = host.split(':').next()?.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    Some(host.strip_prefix("www.").unwrap_or(&host).to_string())
}

/// Web origin only: credentials, paths, queries and fragments are dropped.
pub fn url_origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host_port = rest.split(['/', '?', '#']).next()?;
    let host = host_port.rsplit_once('@').map(|(_, h)| h).unwrap_or(host_port);
    if host.is_empty() {
        return None;
    }
    Some(format!("{}://{}", scheme.to_ascii_lowercase(), host.to_ascii_lowercase()))
}

pub struct AppRow {
    pub id: i64,
    pub icon_path: Option<String>,
}

pub fn upsert_application(conn: &Connection, bundle_id: &str, version: &str, display_name: &str) -> Result<AppRow> {
    if let Some(row) = conn
        .query_row(
            "SELECT id, icon_path FROM application WHERE bundle_id = ?1 AND version = ?2",
            params![bundle_id, version],
            |r| Ok(AppRow { id: r.get(0)?, icon_path: r.get(1)? }),
        )
        .optional()?
    {
        return Ok(row);
    }
    // Reuse the icon of another version of the same app.
    let icon: Option<(Option<String>, Option<i64>)> = conn
        .query_row(
            "SELECT icon_path, dominant_color FROM application WHERE bundle_id = ?1 AND icon_path IS NOT NULL LIMIT 1",
            [bundle_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (icon_path, color) = icon.unwrap_or((None, None));
    conn.execute(
        "INSERT INTO application(bundle_id, version, display_name, is_user_app, icon_path, dominant_color)
         VALUES (?1, ?2, ?3, 1, ?4, ?5)",
        params![bundle_id, version, display_name, icon_path, color],
    )?;
    Ok(AppRow { id: conn.last_insert_rowid(), icon_path })
}

pub fn upsert_domain(conn: &Connection, domain: &str) -> Result<i64> {
    conn.execute("INSERT OR IGNORE INTO domain(normalized_domain) VALUES (?1)", [domain])?;
    Ok(conn.query_row("SELECT id FROM domain WHERE normalized_domain = ?1", [domain], |r| r.get(0))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn fts_tracks_frame_text() {
        let conn = mem();
        conn.execute(
            "INSERT INTO frame(timestamp, foreground, title) VALUES (1, 'webhook signatures verified', 'Docs')",
            [],
        )
        .unwrap();
        let hits: i64 = conn
            .query_row("SELECT count(*) FROM ocr_fts WHERE ocr_fts MATCH 'signature'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hits, 1, "porter stemming matches singular");
        conn.execute("UPDATE frame SET foreground = 'nothing here' WHERE id = 1", []).unwrap();
        let hits: i64 = conn
            .query_row("SELECT count(*) FROM ocr_fts WHERE ocr_fts MATCH 'signature'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hits, 0, "update trigger reindexes");
    }

    #[test]
    fn domains_and_origins_normalize() {
        assert_eq!(normalize_domain("https://www.GitHub.com/a/b?x=1"), Some("github.com".into()));
        assert_eq!(normalize_domain("http://user:pw@localhost:3000/x"), Some("localhost".into()));
        assert_eq!(normalize_domain("file:///Users/x"), None);
        assert_eq!(url_origin("https://u:p@Example.com:8443/reset?token=abc#f"), Some("https://example.com:8443".into()));
    }

    #[test]
    fn application_upsert_reuses_icons_across_versions() {
        let conn = mem();
        let a = upsert_application(&conn, "com.x", "1.0", "X").unwrap();
        conn.execute("UPDATE application SET icon_path = 'icons/x.png' WHERE id = ?1", [a.id]).unwrap();
        let again = upsert_application(&conn, "com.x", "1.0", "X").unwrap();
        assert_eq!(a.id, again.id);
        let b = upsert_application(&conn, "com.x", "2.0", "X").unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(b.icon_path.as_deref(), Some("icons/x.png"));
    }
}
