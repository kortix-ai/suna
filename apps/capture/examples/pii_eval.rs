//! Streaming evaluation adapter for synthetic PII datasets. Uses the same
//! detector as capture; no fixture values, network or production library.
use kortix_backend::memory::{privacy_model::LocalPrivacyModel, redaction};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--install-model") {
        let paths = kortix_backend::memory::paths::MemoryPaths::at(
            args.get(1)
                .ok_or_else(|| anyhow::anyhow!("expected library directory"))?,
        );
        kortix_backend::memory::privacy_model::install_blocking(&paths)?;
        return Ok(());
    }
    let mut model = if args.first().map(String::as_str) == Some("--model") {
        let mut model = LocalPrivacyModel::load(std::path::Path::new(
            args.get(1)
                .ok_or_else(|| anyhow::anyhow!("expected model directory"))?,
        ))?;
        if let Some(penalty) = args.get(2) {
            model.set_background_penalty(penalty.parse()?);
        }
        Some(model)
    } else {
        None
    };
    // Compile patterns before timing individual documents.
    redaction::redact("synthetic warmup");
    let stdout = io::stdout();
    let mut output = stdout.lock();
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line?)?;
        let text = input["text"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("expected text"))?;
        let start = std::time::Instant::now();
        let spans = model
            .as_mut()
            .map(|model| model.detect(text))
            .transpose()?
            .unwrap_or_default();
        let result = redaction::redact_with_spans(text, &spans);
        let micros = start.elapsed().as_secs_f64() * 1_000_000.0;
        serde_json::to_writer(
            &mut output,
            &json!({"ranges": result.ranges, "text": result.text, "micros": micros}),
        )?;
        writeln!(output)?;
        output.flush()?;
    }
    Ok(())
}
