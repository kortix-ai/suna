//! Local OpenAI Privacy Filter, pinned quantized ONNX weights. Only explicit
//! installation downloads assets; inference has no HTTP client or fallback.
use super::{paths::MemoryPaths, redaction::Span};
use anyhow::{Context, Result};
use ort::{session::Session, value::Tensor};
use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};
use tokenizers::Tokenizer;

pub const REVISION: &str = "7ffa9a043d54d1be65afb281eddf0ffbe629385b";
const ASSETS: [(&str, &str); 3] = [
    (
        "tokenizer.json",
        "0614fe83cadab421296e664e1f48f4261fa8fef6e03e63bb75c20f38e37d07d3",
    ),
    (
        "onnx/model_q4.onnx",
        "8f7dee8b46d096f052b359375dfba5d983cc4d18c44a783bf548615c472f8dea",
    ),
    (
        "onnx/model_q4.onnx_data",
        "f30998e28c71c5374cc7e8b7de8f0f83e981592c0c2d652d2ad4928454dbb496",
    ),
];
const LABELS: [&str; 8] = [
    "[account]",
    "[address]",
    "[date]",
    "[email]",
    "[person]",
    "[phone]",
    "[url]",
    "[secret]",
];
const WINDOW: usize = 512;
const OVERLAP: usize = 128;

pub fn model_dir(paths: &MemoryPaths) -> PathBuf {
    paths.root.join("privacy-model")
}

#[cfg(target_os = "macos")]
pub const RUNTIME_NAME: &str = "libonnxruntime.1.23.2.dylib";
#[cfg(target_os = "windows")]
pub const RUNTIME_NAME: &str = "onnxruntime.dll";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub const RUNTIME_NAME: &str = "libonnxruntime.so.1.23.2";

pub fn runtime_path(root: &Path) -> PathBuf {
    let bundled = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.join(RUNTIME_NAME)));
    bundled
        .filter(|p| p.is_file())
        .unwrap_or_else(|| root.join(RUNTIME_NAME))
}

fn checksum(path: &Path) -> Result<String> {
    let mut reader = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// One model per process: the frame recorder and the transcript writer share
/// it, so turning on transcription never loads the weights twice.
static SHARED: std::sync::Mutex<Option<LocalPrivacyModel>> = std::sync::Mutex::new(None);

/// The process-wide model, loaded on first use. Fails when it is not installed.
pub fn shared(
    paths: &MemoryPaths,
) -> Result<std::sync::MutexGuard<'static, Option<LocalPrivacyModel>>> {
    let mut guard = SHARED.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(LocalPrivacyModel::load(&model_dir(paths))?);
    }
    Ok(guard)
}

/// Drop the shared model (weights and its RAM cache of text).
pub fn release_shared() {
    *SHARED.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// Owns a single CPU session, bounded windows, and a small RAM-only cache for
/// unchanged screens. Dropping this object releases cached unredacted text.
pub struct LocalPrivacyModel {
    tokenizer: Tokenizer,
    session: Session,
    cache: VecDeque<(String, Vec<Span>)>,
    background_penalty: f32,
}

impl LocalPrivacyModel {
    pub fn load(root: &Path) -> Result<Self> {
        for (name, hash) in ASSETS {
            anyhow::ensure!(
                checksum(&root.join(name)).ok().as_deref() == Some(hash),
                "Local privacy model missing or invalid; run `kortix-capture privacy-model --install`"
            );
        }
        let runtime = runtime_path(root);
        anyhow::ensure!(
            runtime.is_file(),
            "Local privacy runtime missing; run `kortix-capture privacy-model --install`"
        );
        // init_from is fallible; unlike the default dynamic loader it never
        // searches a random system installation or panics for a missing DLL.
        ort::init_from(runtime)?
            .with_name("Kortix local privacy")
            // Official Windows ORT builds enable telemetry by default. The
            // privacy detector must never opt into that separate data path.
            .with_telemetry(false)
            .commit();
        let tokenizer = Tokenizer::from_file(root.join("tokenizer.json"))
            .map_err(|_| anyhow::anyhow!("Invalid privacy tokenizer"))?;
        let session = Session::builder()?
            .with_intra_threads(2)?
            .with_inter_threads(1)?
            .commit_from_file(root.join("onnx/model_q4.onnx"))?;
        Ok(Self {
            tokenizer,
            session,
            cache: VecDeque::new(),
            background_penalty: 2.0,
        })
    }

    /// Used by the synthetic calibration harness. Production uses the measured
    /// operating point; no user text or model outputs are logged.
    pub fn set_background_penalty(&mut self, penalty: f32) {
        self.background_penalty = penalty;
        self.cache.clear();
    }

    pub fn detect(&mut self, text: &str) -> Result<Vec<Span>> {
        anyhow::ensure!(
            text.len() <= 64 * 1024,
            "Privacy text exceeds bounded inference budget"
        );
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        if let Some((_, spans)) = self.cache.iter().find(|(cached, _)| cached == text) {
            return Ok(spans.clone());
        }
        let encoded = self
            .tokenizer
            .encode(text, false)
            .map_err(|_| anyhow::anyhow!("Privacy tokenization failed"))?;
        let ids = encoded.get_ids();
        let offsets = encoded.get_offsets();
        let mut found = Vec::new();
        let mut start = 0;
        while start < ids.len() {
            let end = (start + WINDOW).min(ids.len());
            let data: Vec<i64> = ids[start..end].iter().map(|id| i64::from(*id)).collect();
            let input = Tensor::from_array(([1usize, data.len()], data.into_boxed_slice()))?;
            let mask = Tensor::from_array((
                [1usize, end - start],
                vec![1i64; end - start].into_boxed_slice(),
            ))?;
            let outputs = self
                .session
                .run(ort::inputs!["input_ids" => input, "attention_mask" => mask])?;
            let (shape, logits) = outputs["logits"].try_extract_tensor::<f32>()?;
            anyhow::ensure!(
                shape.as_ref() == [1, (end - start) as i64, 33]
                    && logits.iter().all(|x| x.is_finite()),
                "Invalid privacy inference output"
            );
            let labels = decode(logits, self.background_penalty);
            let mut token = 0;
            while token < labels.len() {
                if labels[token] == 0 {
                    token += 1;
                    continue;
                }
                let first = token;
                let category = (labels[token] - 1) / 4;
                token += 1;
                while token < labels.len()
                    && labels[token] != 0
                    && (labels[token] - 1) / 4 == category
                    && tag(labels[token]) != 0
                    && tag(labels[token]) != 3
                {
                    token += 1;
                }
                let (mut a, mut b) = (offsets[start + first].0, offsets[start + token - 1].1);
                // Byte-level BPE may split a Unicode scalar across tokens.
                while a > 0 && !text.is_char_boundary(a) {
                    a -= 1;
                }
                while b < text.len() && !text.is_char_boundary(b) {
                    b += 1;
                }
                if a < b && b <= text.len() {
                    let trimmed = text[a..b].trim();
                    a += text[a..b].len() - text[a..b].trim_start().len();
                    b = a + trimmed.len();
                    if a < b {
                        found.push(Span {
                            start: a,
                            end: b,
                            replacement: LABELS[category],
                        });
                    }
                }
            }
            if end == ids.len() {
                break;
            }
            start = end - OVERLAP;
        }
        expand_context(text, &mut found);
        self.cache.push_back((text.to_owned(), found.clone()));
        while self.cache.len() > 8 {
            self.cache.pop_front();
        }
        Ok(found)
    }
}

/// High-recall boundaries for form fields and model fragments. These rules
/// don't contain fixture names/addresses; they use field semantics and layout.
fn expand_context(text: &str, spans: &mut Vec<Span>) {
    use regex::Regex;
    static NAME_FIELD: OnceLock<Regex> = OnceLock::new();
    let name_field = NAME_FIELD.get_or_init(|| Regex::new(r#"(?im)^(?:(?:customer|contact|full|first|last|given|family|recipient|cardholder|billing|shipping)[ \t]+)?name[ \t*"':=]+(?P<value>[^\n;]{2,100})"#).unwrap());
    for capture in name_field.captures_iter(text) {
        let value = capture.name("value").unwrap();
        let trimmed = value.as_str().trim_end();
        if !trimmed.is_empty() {
            spans.push(Span {
                start: value.start(),
                end: value.start() + trimmed.len(),
                replacement: "[person]",
            });
        }
    }
    static RULES: OnceLock<(Regex, Regex, Regex, Regex)> = OnceLock::new();
    let (field, next_field, person_word, address_tail) = RULES.get_or_init(|| (
        Regex::new(r#"(?im)\b(?:(?:shipping|billing|street|home|mailing|postal)[ \t]+)?address\b[ \t*"':=]+(?P<value>[^\n;]{4,180})"#).unwrap(),
        Regex::new(r#"(?i),\s*(?:phone|mobile|email|ssn|social security|date|biometric|customer|account|order|status|total)\b\s*[:*=]"#).unwrap(),
        Regex::new(r"^(?:[ \t-]+(?:[\p{Lu}][\p{L}'’-]*|[\p{Lu}]\.)){1,3}").unwrap(),
        Regex::new(r"^(?:,[ \t]*(?:[\p{Lu}][\p{L}'’-]*|[0-9][0-9 -]*)(?:[ \t]+(?:[\p{Lu}][\p{L}'’-]*|[0-9][0-9 -]*)){0,5}){1,4}").unwrap(),
    ));
    for span in spans.iter_mut() {
        if span.replacement == "[person]" {
            if let Some(tail) = person_word.find(&text[span.end..]) {
                span.end += tail.end();
            }
            // Keep common title prefixes with the protected name.
            for title in ["Mr. ", "Mrs. ", "Ms. ", "Dr. ", "Prof. ", "Ind. "] {
                if text[..span.start].ends_with(title) {
                    span.start -= title.len();
                    break;
                }
            }
        } else if span.replacement == "[address]" {
            if let Some(tail) = address_tail.find(&text[span.end..]) {
                span.end += tail.end();
            }
        }
    }
    for capture in field.captures_iter(text) {
        let value = capture.name("value").unwrap();
        let mut end = next_field
            .find(value.as_str())
            .map_or(value.end(), |m| value.start() + m.start());
        // A following sentence is context, not part of the field.
        if let Some(stop) = text[value.start()..end].find(". ") {
            end = value.start() + stop;
        }
        while end > value.start() && text.as_bytes()[end - 1].is_ascii_whitespace() {
            end -= 1;
        }
        if end > value.start() {
            spans.push(Span {
                start: value.start(),
                end,
                replacement: "[address]",
            });
        }
    }
}

// Constrained BIOES Viterbi, following OpenAI's documented transition rules
// (github.com/openai/privacy-filter/opf/_core/decoding.py, Apache-2.0).
fn tag(label: usize) -> usize {
    (label - 1) % 4
} // B,I,E,S
fn complete(label: usize) -> bool {
    label == 0 || tag(label) >= 2
}
fn begins(label: usize) -> bool {
    label == 0 || matches!(tag(label), 0 | 3)
}
fn allowed(previous: usize, next: usize) -> bool {
    if complete(previous) {
        begins(next)
    } else {
        next != 0 && (previous - 1) / 4 == (next - 1) / 4 && matches!(tag(next), 1 | 2)
    }
}

fn decode(logits: &[f32], penalty: f32) -> Vec<usize> {
    let length = logits.len() / 33;
    if length == 0 {
        return Vec::new();
    }
    let mut scores = [f32::NEG_INFINITY; 33];
    for i in 0..33 {
        if begins(i) {
            scores[i] = logits[i] - if i == 0 { penalty } else { 0.0 };
        }
    }
    let mut back = vec![[0u8; 33]; length];
    for t in 1..length {
        let mut next_scores = [f32::NEG_INFINITY; 33];
        for next in 0..33 {
            for previous in 0..33 {
                if allowed(previous, next) && scores[previous] > next_scores[next] {
                    next_scores[next] = scores[previous];
                    back[t][next] = previous as u8;
                }
            }
            next_scores[next] += logits[t * 33 + next] - if next == 0 { penalty } else { 0.0 };
        }
        scores = next_scores;
    }
    let mut last = (0..33)
        .filter(|i| complete(*i))
        .max_by(|a, b| scores[*a].total_cmp(&scores[*b]))
        .unwrap_or(0);
    let mut result = vec![0; length];
    for t in (0..length).rev() {
        result[t] = last;
        last = back[t][last] as usize;
    }
    result
}

#[derive(Default)]
struct InstallState {
    running: bool,
    downloaded: u64,
    phase: &'static str,
    error: Option<String>,
}
type Installs = HashMap<PathBuf, Arc<Mutex<InstallState>>>;
fn install_state(paths: &MemoryPaths) -> Arc<Mutex<InstallState>> {
    static STATES: OnceLock<Mutex<Installs>> = OnceLock::new();
    STATES
        .get_or_init(Default::default)
        .lock()
        .entry(paths.root.clone())
        .or_default()
        .clone()
}

pub fn status(paths: &MemoryPaths) -> Value {
    let state = install_state(paths);
    let state = state.lock();
    let root = model_dir(paths);
    json!({"installed": root.join("installed.json").is_file() && ASSETS.iter().all(|(name,_)| root.join(name).is_file()) && runtime_path(&root).is_file(), "downloading": state.running, "downloaded_bytes": state.downloaded, "phase": if state.running { state.phase } else { "idle" }, "error": state.error, "model": "openai/privacy-filter", "revision": REVISION})
}

pub fn start_install(paths: &MemoryPaths) -> Result<()> {
    anyhow::ensure!(
        !super::settings::Settings::load(paths).airgap,
        "Turn off airgap to download model assets, or install them offline"
    );
    let state = install_state(paths);
    {
        let mut s = state.lock();
        anyhow::ensure!(!s.running, "Privacy model installation already running");
        s.running = true;
        s.downloaded = 0;
        s.phase = "checking";
        s.error = None;
    }
    let paths = paths.clone();
    std::thread::spawn(move || {
        let result = install(&paths, &state);
        let mut s = state.lock();
        s.running = false;
        if result.is_err() {
            s.error = Some(
                "Model installation failed; retry the download or check available disk space"
                    .into(),
            );
        }
    });
    Ok(())
}

pub fn install_blocking(paths: &MemoryPaths) -> Result<()> {
    anyhow::ensure!(
        !super::settings::Settings::load(paths).airgap,
        "Turn off airgap to download model assets, or install them offline"
    );
    install(paths, &Arc::new(Mutex::new(InstallState::default())))
}

fn download(
    client: &reqwest::blocking::Client,
    url: &str,
    target: &Path,
    expected: &str,
    state: &Arc<Mutex<InstallState>>,
) -> Result<()> {
    state.lock().phase = "checking";
    if checksum(target).ok().as_deref() == Some(expected) {
        return Ok(());
    }
    fs::create_dir_all(target.parent().context("asset parent")?)?;
    let temporary = target.with_extension("download");
    state.lock().phase = "downloading";
    let mut response = client.get(url).send()?.error_for_status()?;
    let mut file = File::create(&temporary)?;
    let mut hash = Sha256::new();
    let mut bytes = [0u8; 128 * 1024];
    loop {
        let n = response.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        file.write_all(&bytes[..n])?;
        hash.update(&bytes[..n]);
        state.lock().downloaded += n as u64;
    }
    file.sync_all()?;
    anyhow::ensure!(
        format!("{:x}", hash.finalize()) == expected,
        "Privacy asset checksum mismatch"
    );
    fs::rename(temporary, target)?;
    Ok(())
}

fn install(paths: &MemoryPaths, state: &Arc<Mutex<InstallState>>) -> Result<()> {
    let root = model_dir(paths);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()?;
    for (name, hash) in ASSETS {
        download(
            &client,
            &format!("https://huggingface.co/openai/privacy-filter/resolve/{REVISION}/{name}"),
            &root.join(name),
            hash,
            state,
        )?;
    }
    if !runtime_path(&root).is_file() {
        install_runtime(&root, state, &client)?;
    }
    // Verify that the actual local tokenizer/runtime/model loads before saying
    // installed. No synthetic or user input is sent over the network.
    state.lock().phase = "verifying";
    LocalPrivacyModel::load(&root)?;
    fs::write(
        root.join("installed.json"),
        serde_json::to_vec_pretty(
            &json!({"model": "openai/privacy-filter", "revision": REVISION, "runtime": "1.23.2"}),
        )?,
    )?;
    Ok(())
}

fn install_runtime(
    root: &Path,
    state: &Arc<Mutex<InstallState>>,
    client: &reqwest::blocking::Client,
) -> Result<()> {
    let (asset, hash) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => (
            "onnxruntime-osx-arm64-1.23.2.tgz",
            "b4d513ab2b26f088c66891dbbc1408166708773d7cc4163de7bdca0e9bbb7856",
        ),
        ("macos", "x86_64") => (
            "onnxruntime-osx-x86_64-1.23.2.tgz",
            "d10359e16347b57d9959f7e80a225a5b4a66ed7d7e007274a15cae86836485a6",
        ),
        ("windows", "x86_64") => (
            "onnxruntime-win-x64-1.23.2.zip",
            "0b38df9af21834e41e73d602d90db5cb06dbd1ca618948b8f1d66d607ac9f3cd",
        ),
        ("linux", "x86_64") => (
            "onnxruntime-linux-x64-1.23.2.tgz",
            "1fa4dcaef22f6f7d5cd81b28c2800414350c10116f5fdd46a2160082551c5f9b",
        ),
        _ => anyhow::bail!("Local privacy model runtime is unavailable on this platform"),
    };
    let archive = root.join(asset);
    download(
        client,
        &format!("https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/{asset}"),
        &archive,
        hash,
        state,
    )?;
    let target = root.join(RUNTIME_NAME);
    state.lock().phase = "runtime";
    if asset.ends_with(".zip") {
        let mut archive = zip::ZipArchive::new(File::open(&archive)?)?;
        let entry = format!("onnxruntime-win-x64-1.23.2/lib/{RUNTIME_NAME}");
        let mut entry = archive.by_name(&entry)?;
        std::io::copy(&mut entry, &mut File::create(&target)?)?;
    } else {
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(File::open(&archive)?));
        let mut found = false;
        for entry in archive.entries()? {
            let mut entry = entry?;
            if entry.header().entry_type().is_file()
                && entry.path()?.file_name().is_some_and(|n| n == RUNTIME_NAME)
            {
                std::io::copy(&mut entry, &mut File::create(&target)?)?;
                found = true;
                break;
            }
        }
        anyhow::ensure!(found, "Privacy runtime archive missing library");
    }
    Ok(())
}

/// Batch metadata into one context-preserving text inference and map the
/// byte spans back to each string. Replacements never cross JSON boundaries.
pub fn redact_metadata(model: &mut LocalPrivacyModel, value: &mut Value) -> Result<()> {
    fn collect(
        value: &Value,
        context: &str,
        text: &mut String,
        positions: &mut Vec<(usize, usize)>,
    ) {
        match value {
            Value::String(s) => {
                text.push_str(context);
                text.push_str(": ");
                let start = text.len();
                text.push_str(s);
                positions.push((start, text.len()));
                text.push('\n');
            }
            Value::Array(items) => {
                for item in items {
                    collect(item, context, text, positions);
                }
            }
            Value::Object(fields) => {
                for (key, item) in fields {
                    collect(item, key, text, positions);
                }
            }
            _ => {}
        }
    }
    fn replace(
        value: &mut Value,
        positions: &[(usize, usize)],
        cursor: &mut usize,
        spans: &[Span],
    ) {
        match value {
            Value::String(s) => {
                let (start, end) = positions[*cursor];
                *cursor += 1;
                let local: Vec<Span> = spans
                    .iter()
                    .filter(|span| span.start < end && span.end > start)
                    .map(|span| Span {
                        start: span.start.max(start) - start,
                        end: span.end.min(end) - start,
                        replacement: span.replacement,
                    })
                    .collect();
                *s = super::redaction::redact_with_spans(s, &local).text;
            }
            Value::Array(items) => {
                for item in items {
                    replace(item, positions, cursor, spans);
                }
            }
            Value::Object(fields) => {
                for item in fields.values_mut() {
                    replace(item, positions, cursor, spans);
                }
            }
            _ => {}
        }
    }
    let mut text = String::new();
    let mut positions = Vec::new();
    collect(value, "value", &mut text, &mut positions);
    let spans = model.detect(&text)?;
    replace(value, &positions, &mut 0, &spans);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn progress_is_local_and_does_not_enable_masking() {
        let dir =
            std::env::temp_dir().join(format!("kortix-privacy-progress-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let paths = MemoryPaths::at(&dir);
        let initial = status(&paths);
        assert_eq!(initial["installed"], false);
        assert_eq!(initial["downloading"], false);
        assert_eq!(initial["phase"], "idle");

        let state = install_state(&paths);
        {
            let mut state = state.lock();
            state.running = true;
            state.phase = "verifying";
            state.downloaded = 123;
        }
        let progress = status(&paths);
        assert_eq!(progress["phase"], "verifying");
        assert_eq!(progress["downloaded_bytes"], 123);
        assert_eq!(progress["installed"], false);
        assert!(
            !super::super::settings::Settings::load(&paths)
                .privacy
                .redact_pii
        );
        assert!(!paths.settings().exists());

        // An explicit airgap refusal must not launch a download or opt in.
        state.lock().running = false;
        let mut settings = super::super::settings::Settings::default();
        settings.airgap = true;
        settings.save(&paths).unwrap();
        assert!(start_install(&paths).is_err());
        assert_eq!(status(&paths)["downloading"], false);
        assert!(
            !super::super::settings::Settings::load(&paths)
                .privacy
                .redact_pii
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn decoder_enforces_complete_spans_and_handles_background() {
        let mut logits = vec![-20.0; 3 * 33];
        logits[0] = 10.0;
        logits[33 + 17] = 10.0; // B-person
        logits[66 + 19] = 10.0; // E-person
        assert_eq!(decode(&logits, 0.0), vec![0, 17, 19]);
        assert_eq!(decode(&[0.0; 33], 0.0), vec![32]);
        assert!(!allowed(17, 0));
        assert!(!allowed(17, 7));
        assert!(allowed(17, 19));
        assert!(allowed(19, 0));
    }
}
