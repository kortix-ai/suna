//! Serve the timeline window's `kmem://` API over HTTP on 127.0.0.1, for headless
//! browser checks of `ui/memory/` against a scratch library. Development only: the
//! window itself never opens a port. The Kortix approval page is never opened.
//!
//! ```text
//! KORTIX_CAPTURE_KEY_STORE=file cargo run --example memory_ui_server -- <library dir> [port]
//! ```

use kortix_backend::memory::{paths::MemoryPaths, ui::api::Ctx};
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::Arc;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let lib = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("usage: memory_ui_server <library dir> [port]"))?;
    let port: u16 = args.next().map(|p| p.parse()).transpose()?.unwrap_or(8765);
    let mut ctx = Ctx::new(MemoryPaths::at(lib));
    ctx.open_browser = false;
    let ctx = Arc::new(ctx);
    let listener = std::net::TcpListener::bind(("127.0.0.1", port))?;
    eprintln!("memory ui on http://127.0.0.1:{port}/");
    for stream in listener.incoming().flatten() {
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let _ = serve(&ctx, stream);
        });
    }
    Ok(())
}

fn serve(ctx: &Ctx, stream: std::net::TcpStream) -> anyhow::Result<()> {
    let mut r = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    r.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, uri) = (
        parts.next().unwrap_or("GET").to_string(),
        parts.next().unwrap_or("/").to_string(),
    );
    let (mut len, mut range) = (0usize, None);
    loop {
        let mut h = String::new();
        if r.read_line(&mut h)? == 0 || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "content-length" => len = v.trim().parse().unwrap_or(0),
                "range" => range = Some(v.trim().to_string()),
                _ => {}
            }
        }
    }
    let mut body = vec![0; len];
    r.read_exact(&mut body)?;
    let resp = ctx.handle(&method, &uri, range.as_deref(), &body);
    let mut out = stream;
    write!(
        out,
        "HTTP/1.1 {} X\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        resp.status,
        resp.content_type,
        resp.body.len()
    )?;
    for (k, v) in &resp.headers {
        write!(out, "{k}: {v}\r\n")?;
    }
    out.write_all(b"\r\n")?;
    out.write_all(&resp.body)?;
    Ok(())
}
