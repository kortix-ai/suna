//! Protocol conformance for the Rust capture engine (Windows and Linux).
//! Spawns the real binary, speaks JSON lines, and checks ping, permissions,
//! ocr on a synthetic PNG, convert/crop, and the error path.
#![cfg(any(target_os = "windows", target_os = "linux"))]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

struct Engine {
    child: Child,
    stdin: ChildStdin,
    out: BufReader<ChildStdout>,
    next: u64,
}

impl Engine {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_kortix-capture-engine"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn engine");
        let stdin = child.stdin.take().unwrap();
        let out = BufReader::new(child.stdout.take().unwrap());
        Engine { child, stdin, out, next: 1 }
    }

    fn call(&mut self, mut req: Value) -> Value {
        let id = self.next;
        self.next += 1;
        req["id"] = json!(id);
        writeln!(self.stdin, "{req}").unwrap();
        self.stdin.flush().unwrap();
        let mut line = String::new();
        self.out.read_line(&mut line).unwrap();
        let v: Value = serde_json::from_str(&line).unwrap_or_else(|_| panic!("bad response {line:?}"));
        assert_eq!(v["id"], json!(id), "id must be echoed");
        v
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// White canvas with big black block letters "KORTIX 42" drawn from a 5x7 font.
fn synthetic_png(path: &std::path::Path) {
    const GLYPHS: &[(char, [&str; 7])] = &[
        ('K', ["10001", "10010", "10100", "11000", "10100", "10010", "10001"]),
        ('O', ["01110", "10001", "10001", "10001", "10001", "10001", "01110"]),
        ('R', ["11110", "10001", "10001", "11110", "10100", "10010", "10001"]),
        ('T', ["11111", "00100", "00100", "00100", "00100", "00100", "00100"]),
        ('I', ["01110", "00100", "00100", "00100", "00100", "00100", "01110"]),
        ('X', ["10001", "10001", "01010", "00100", "01010", "10001", "10001"]),
        ('4', ["00010", "00110", "01010", "10010", "11111", "00010", "00010"]),
        ('2', ["01110", "10001", "00001", "00010", "00100", "01000", "11111"]),
    ];
    let scale = 12u32;
    let text = "KORTIX 42";
    let (w, h) = (700u32, 200u32);
    let mut img = image::RgbImage::from_pixel(w, h, image::Rgb([255, 255, 255]));
    let mut x0 = 30u32;
    for ch in text.chars() {
        if let Some((_, rows)) = GLYPHS.iter().find(|(c, _)| *c == ch) {
            for (ry, row) in rows.iter().enumerate() {
                for (rx, bit) in row.chars().enumerate() {
                    if bit == '1' {
                        for dy in 0..scale {
                            for dx in 0..scale {
                                img.put_pixel(x0 + rx as u32 * scale + dx, 50 + ry as u32 * scale + dy, image::Rgb([0, 0, 0]));
                            }
                        }
                    }
                }
            }
        }
        x0 += 6 * scale + 2;
    }
    img.save(path).unwrap();
}

#[test]
fn ping_permissions_unknown_and_bad_json() {
    let mut e = Engine::start();
    let pong = e.call(json!({"cmd": "ping"}));
    assert_eq!(pong["ok"], json!(true));
    assert_eq!(pong["pong"], json!(true));
    assert!(pong["pid"].as_u64().unwrap() > 0);

    let perms = e.call(json!({"cmd": "permissions"}));
    assert_eq!(perms["ok"], json!(true));
    assert!(perms["screen"].is_boolean() && perms["accessibility"].is_boolean(), "{perms}");

    let bad = e.call(json!({"cmd": "nope"}));
    assert_eq!(bad["ok"], json!(false));
    assert!(bad["error"].as_str().unwrap().starts_with("unknown_cmd"));

    writeln!(e.stdin, "not json").unwrap();
    let mut line = String::new();
    e.out.read_line(&mut line).unwrap();
    let v: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v, json!({"ok": false, "error": "bad_json"}));
}

#[test]
fn convert_crops_and_ocr_reads_synthetic_png() {
    let dir = std::env::temp_dir().join(format!("kce-proto-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let png = dir.join("in.png");
    synthetic_png(&png);
    let mut e = Engine::start();

    let out = dir.join("crop.png");
    let c = e.call(json!({"cmd": "convert", "path": png, "out": out, "crop": {"x": 10, "y": 20, "w": 300, "h": 100}}));
    assert_eq!(c["ok"], json!(true), "{c}");
    assert_eq!((c["width"].as_u64(), c["height"].as_u64()), (Some(300), Some(100)));

    let missing = e.call(json!({"cmd": "ocr", "path": dir.join("absent.png")}));
    assert_eq!(missing["ok"], json!(false));
    assert_eq!(missing["error"], json!("image_not_found"));

    let r = e.call(json!({"cmd": "ocr", "path": png, "level": "accurate", "languages": []}));
    if r["ok"] == json!(false) {
        // No OCR backend on this host (no tesseract / no Windows OCR pack): the
        // error must name it. Never a silent success with no boxes.
        let err = r["error"].as_str().unwrap();
        assert!(err.contains("ocr_unavailable") || err.starts_with("ocr_failed"), "{r}");
        eprintln!("SKIP ocr text assertion: {err}");
    } else {
        assert_eq!((r["width"].as_u64(), r["height"].as_u64()), (Some(700), Some(200)));
        let text: String = r["boxes"].as_array().unwrap().iter().map(|b| b["text"].as_str().unwrap().to_uppercase()).collect::<Vec<_>>().join(" ");
        assert!(text.contains("KORTIX") || text.contains("42"), "OCR text {text:?}");
        let b = &r["boxes"][0];
        for k in ["x", "y", "w", "h", "text", "confidence"] {
            assert!(b.get(k).is_some(), "box field {k}");
        }
    }
    let _ = std::fs::remove_dir_all(dir);
}
