//! OCR text of one frame grouped by window: which window shows which text,
//! how much of each window is visible, overlays (menus, popups) vs main windows.

use anyhow::{bail, Result};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct Group {
    pub app: String,
    pub bundle: String,
    pub title: String,
    pub size: String,
    pub overlay: bool,
    pub focused: bool,
    pub visible_pct: i64,
    pub texts: Vec<String>,
}

#[derive(Debug, Default)]
pub struct Screen {
    /// Overlays first, then main windows; each block top of the z-order first.
    pub groups: Vec<Group>,
    pub warnings: Vec<String>,
}

struct Win {
    title: String,
    app: String,
    bundle: String,
    rect: (f64, f64, f64, f64),
    overlay: bool,
    focused: bool,
}

fn contains(r: (f64, f64, f64, f64), x: f64, y: f64) -> bool {
    x >= r.0 && x < r.0 + r.2 && y >= r.1 && y < r.1 + r.3
}

/// Fraction (0..=100) of the window's on-image area not covered by windows above it.
fn visible_pct(wins: &[Win], i: usize, img: (f64, f64)) -> (i64, f64) {
    let r = wins[i].rect;
    let (x0, y0, x1, y1) = (r.0.max(0.0), r.1.max(0.0), (r.0 + r.2).min(img.0), (r.1 + r.3).min(img.1));
    if x1 <= x0 || y1 <= y0 {
        return (0, 0.0);
    }
    let area = (x1 - x0) * (y1 - y0) / (img.0 * img.1) * 100.0;
    const N: usize = 20;
    let mut seen = 0;
    for gy in 0..N {
        for gx in 0..N {
            let (px, py) = (x0 + (x1 - x0) * (gx as f64 + 0.5) / N as f64, y0 + (y1 - y0) * (gy as f64 + 0.5) / N as f64);
            if !wins[..i].iter().any(|w| contains(w.rect, px, py)) {
                seen += 1;
            }
        }
    }
    ((seen * 100 + N * N / 2) as i64 / (N * N) as i64, area)
}

pub fn load(conn: &Connection, frame_id: i64) -> Result<Screen> {
    type FrameRow = (Option<String>, Option<String>, i64, i64, f64, f64, f64, f64, i64, Option<String>);
    let row: Option<FrameRow> = conn
        .query_row(
            "SELECT f.foreground, f.background, COALESCE(f.width,0), COALESCE(f.height,0),
                    COALESCE(f.capture_display_x,0), COALESCE(f.capture_display_y,0),
                    COALESCE(f.capture_display_width,0), COALESCE(f.capture_display_height,0), f.ocr_status,
                    (SELECT COALESCE(a.display_name, a.bundle_id) FROM segment s JOIN application a ON a.id = s.application WHERE s.id = f.segment)
             FROM frame f WHERE f.id = ?1",
            [frame_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)),
        )
        .optional()?;
    let Some((fg, bg, iw, ih, dx, dy, dw, dh, status, app)) = row else { bail!("Frame not found") };
    let chars: Vec<char> = format!("{}{}", fg.unwrap_or_default(), bg.unwrap_or_default()).chars().collect();
    let (sx, sy) = if dw > 0.0 && dh > 0.0 { (iw as f64 / dw, ih as f64 / dh) } else { (1.0, 1.0) };
    let mut stmt = conn.prepare(
        "SELECT w.window_title, w.x, w.y, w.width, w.height, w.window_layer, w.is_focussed_window,
                a.bundle_id, COALESCE(a.display_name, a.bundle_id)
         FROM window_bound w JOIN application a ON a.id = w.application
         WHERE w.frame = ?1 ORDER BY w.z_order, w.id",
    )?;
    let mut wins: Vec<Win> = stmt
        .query_map([frame_id], |r| {
            let (x, y, w, h): (i64, i64, i64, i64) = (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?);
            Ok(Win {
                title: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                rect: ((x as f64 - dx) * sx, (y as f64 - dy) * sy, w as f64 * sx, h as f64 * sy),
                overlay: r.get::<_, i64>(5)? > 0,
                focused: r.get::<_, Option<i64>>(6)?.unwrap_or(0) == 1,
                bundle: r.get(7)?,
                app: r.get(8)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut screen = Screen::default();
    if status == 0 {
        screen.warnings.push("OCR has not run on this frame yet; screen text is missing".into());
    }
    let img = (iw as f64, ih as f64);
    if wins.is_empty() {
        wins.push(Win {
            title: String::new(),
            app: app.unwrap_or_default(),
            bundle: String::new(),
            rect: (0.0, 0.0, img.0, img.1),
            overlay: false,
            focused: true,
        });
        screen.warnings.push("no window layout recorded for this frame".into());
    }
    let mut texts: Vec<Vec<String>> = vec![Vec::new(); wins.len()];
    let fallback = wins.iter().position(|w| w.focused).or_else(|| wins.iter().position(|w| !w.overlay)).unwrap_or(0);
    let mut boxes = conn.prepare("SELECT x, y, width, height, text_offset, text_length FROM ocr WHERE frame = ?1 ORDER BY id")?;
    let rows = boxes.query_map([frame_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?)))?;
    for b in rows {
        let (x, y, w, h, off, len) = b?;
        let text: String = chars.iter().skip(off.max(0) as usize).take(len.max(0) as usize).collect();
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let (cx, cy) = (x as f64 + w as f64 / 2.0, y as f64 + h as f64 / 2.0);
        let owner = wins.iter().position(|win| contains(win.rect, cx, cy)).unwrap_or(fallback);
        texts[owner].push(text.to_string());
    }
    let mut groups = Vec::new();
    for (i, w) in wins.iter().enumerate() {
        let (vis, area) = visible_pct(&wins, i, img);
        let t = std::mem::take(&mut texts[i]);
        if !w.overlay && t.is_empty() && !w.focused {
            continue;
        }
        groups.push(Group {
            app: w.app.clone(),
            bundle: w.bundle.clone(),
            title: w.title.clone(),
            size: format!("{}x{} ({area:.1}%)", w.rect.2.round() as i64, w.rect.3.round() as i64),
            overlay: w.overlay,
            focused: w.focused,
            visible_pct: if w.overlay { 100 } else { vis },
            texts: t,
        });
    }
    screen.groups = groups.iter().filter(|g| g.overlay).chain(groups.iter().filter(|g| !g.overlay)).cloned().collect();
    Ok(screen)
}

impl Group {
    pub fn label(&self) -> String {
        if self.title.is_empty() { self.app.clone() } else { format!("{} - \"{}\"", self.app, self.title) }
    }

    fn overlay_note(&self) -> &'static str {
        let area: f64 = self.size.split(['(', '%']).nth(1).and_then(|p| p.parse().ok()).unwrap_or(0.0);
        if area >= 5.0 {
            "OCR not separable - this overlay likely inserted text into windows below and obscured some text"
        } else {
            "No OCR text detected in this overlay"
        }
    }
}

/// `(overlays, main_windows)` for `--show-ocr` JSON.
pub fn to_json(screen: &Screen) -> (Vec<Value>, Vec<Value>) {
    let (mut overlays, mut main) = (Vec::new(), Vec::new());
    for g in &screen.groups {
        let mut v = json!({
            "application": g.app, "bundle_id": g.bundle, "window_title": g.title, "size": g.size, "texts": g.texts,
        });
        match (g.overlay, g.texts.is_empty()) {
            (true, true) => {
                v["type"] = json!("inactive");
                v["note"] = json!(g.overlay_note());
            }
            (true, false) => {
                v["type"] = json!("significant");
                v["visible"] = json!("100%");
            }
            _ => {
                v["type"] = json!("visible");
                v["visible"] = json!(format!("{}%", g.visible_pct));
            }
        }
        if g.overlay { overlays.push(v) } else { main.push(v) }
    }
    (overlays, main)
}

/// Compact `--show-ocr` body: OVERLAYS then WINDOWS, boxes separated by `|`.
pub fn to_compact(screen: &Screen) -> String {
    let mut out = String::new();
    for (title, overlay) in [("OVERLAYS:", true), ("WINDOWS:", false)] {
        let gs: Vec<&Group> = screen.groups.iter().filter(|g| g.overlay == overlay).collect();
        if gs.is_empty() {
            continue;
        }
        out.push_str(&format!("\n{title}\n"));
        for g in gs {
            let tail = if g.overlay && g.texts.is_empty() { g.overlay_note().to_string() } else { format!("{}% vis", g.visible_pct) };
            out.push_str(&format!("  {} | {} | {tail}\n", g.label(), g.size));
            if !g.texts.is_empty() {
                out.push_str(&format!("    {}\n", g.texts.join(" | ")));
            }
        }
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::store;

    /// One 1000x500 frame: an overlay popup over a full-size editor window over a back window.
    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        store::migrate(&conn).unwrap();
        let ed = store::upsert_application(&conn, "com.example.editor", "1", "Editor").unwrap().id;
        let back = store::upsert_application(&conn, "com.example.back", "1", "Back").unwrap().id;
        conn.execute("INSERT INTO segment(start_frame_id, application) VALUES (1, ?1)", [ed]).unwrap();
        conn.execute(
            "INSERT INTO frame(id, timestamp, width, height, foreground, background, segment, ocr_status,
                               capture_display_x, capture_display_y, capture_display_width, capture_display_height)
             VALUES (1, 1000, 1000, 500, 'alpha\nbeta', 'gamma', 1, 1, 0, 0, 500, 250)",
            [],
        )
        .unwrap();
        for (app, title, x, y, w, h, layer, z, focused) in [
            (ed, "Popup", 200, 100, 50, 50, 101, 0, 0),
            (ed, "main.rs", 0, 0, 400, 250, 0, 1, 1),
            (back, "notes", 0, 0, 500, 250, 0, 2, 0),
        ] {
            conn.execute(
                "INSERT INTO window_bound(frame, application, window_title, x, y, width, height, window_layer, z_order, is_focussed_window)
                 VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![app, title, x, y, w, h, layer, z, focused],
            )
            .unwrap();
        }
        // Boxes in image pixels (2x the point coordinates). alpha+beta in editor, gamma over the back window.
        for (x, y, off, len) in [(20, 20, 0, 5), (30, 60, 6, 4), (900, 100, 10, 5)] {
            conn.execute("INSERT INTO ocr(frame, x, y, width, height, text_offset, text_length) VALUES (1, ?1, ?2, 40, 10, ?3, ?4)", rusqlite::params![x, y, off, len]).unwrap();
        }
        conn
    }

    #[test]
    fn groups_text_by_window_with_overlay_first() {
        let s = load(&fixture(), 1).unwrap();
        assert_eq!(s.groups.len(), 3);
        assert!(s.groups[0].overlay && s.groups[0].texts.is_empty());
        let editor = &s.groups[1];
        assert_eq!(editor.texts, vec!["alpha", "beta"]);
        assert_eq!(editor.size, "800x500 (80.0%)");
        assert_eq!(s.groups[2].texts, vec!["gamma"]);
        assert!((15..=25).contains(&s.groups[2].visible_pct), "{}", s.groups[2].visible_pct);
    }

    #[test]
    fn renders_compact_and_json() {
        let s = load(&fixture(), 1).unwrap();
        let text = to_compact(&s);
        assert!(text.contains("OVERLAYS:\n  Editor - \"Popup\" | 100x100 (2.0%) | No OCR text detected in this overlay"));
        assert!(text.contains("WINDOWS:\n  Editor - \"main.rs\" | 800x500 (80.0%) | 98% vis\n    alpha | beta"));
        let (overlays, main) = to_json(&s);
        assert_eq!(overlays[0]["type"], "inactive");
        assert_eq!(main[0]["type"], "visible");
        assert_eq!(main[0]["bundle_id"], "com.example.editor");
    }

    #[test]
    fn missing_frame_errors() {
        assert!(load(&fixture(), 99).is_err());
    }
}
