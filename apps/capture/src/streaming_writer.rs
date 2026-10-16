use crate::utils::{timestamp, Event};
use anyhow::{Context, Result};
use serde_json::Value;
use std::{
    fs::{File, OpenOptions},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
};

#[derive(Debug)]
pub struct StreamingJsonlinesWriter {
    pub file_path: PathBuf,
    max_buffer_size: usize,
    use_sorted_buffer: bool,
    buffer: Vec<Event>,
    writer: Option<BufWriter<File>>,
    pub is_open: bool,
}

impl StreamingJsonlinesWriter {
    pub fn new(
        file_path: impl AsRef<Path>,
        max_buffer_size: usize,
        use_sorted_buffer: bool,
    ) -> Self {
        Self {
            file_path: file_path.as_ref().to_path_buf(),
            max_buffer_size,
            use_sorted_buffer,
            buffer: Vec::new(),
            writer: None,
            is_open: false,
        }
    }

    pub fn open(mut self) -> Result<Self> {
        if !self.is_open {
            if let Some(parent) = self.file_path.parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("failed to create {}", parent.display()))?;
            }
            let file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&self.file_path)
                .with_context(|| format!("failed to open {}", self.file_path.display()))?;
            self.writer = Some(BufWriter::new(file));
            self.is_open = true;
        }
        Ok(self)
    }

    pub fn write(&mut self, event: Event) -> Result<()> {
        if self.buffer.len() >= self.max_buffer_size {
            self.flush(false)?;
        }
        self.buffer.push(event);
        Ok(())
    }

    pub fn write_all(&mut self, events: Vec<Event>) -> Result<()> {
        for event in events {
            self.write(event)?;
        }
        Ok(())
    }

    pub fn flush(&mut self, flush_all: bool) -> Result<()> {
        if !self.is_open {
            let reopened = std::mem::replace(
                self,
                StreamingJsonlinesWriter::new(
                    &self.file_path,
                    self.max_buffer_size,
                    self.use_sorted_buffer,
                ),
            )
            .open()?;
            *self = reopened;
        }

        if self.buffer.is_empty() {
            return Ok(());
        }

        if self.use_sorted_buffer {
            self.buffer.sort_by(|a, b| {
                timestamp(a)
                    .partial_cmp(&timestamp(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }

        let buffer_len = self.buffer.len();
        let mut num_to_write = if flush_all {
            buffer_len
        } else {
            ((buffer_len as f64) * 0.8) as usize
        };
        if num_to_write == 0 && buffer_len > 0 {
            num_to_write = buffer_len;
        }
        if num_to_write == 0 {
            return Ok(());
        }

        let writer = self
            .writer
            .as_mut()
            .context("jsonlines writer is not open")?;

        for event in self.buffer.drain(..num_to_write) {
            serde_json::to_writer(&mut *writer, &event)?;
            writer.write_all(b"\n")?;
        }
        writer.flush()?;
        Ok(())
    }

    pub fn close(&mut self) -> Result<()> {
        if !self.is_open {
            return Ok(());
        }
        self.flush(true)?;
        if let Some(mut writer) = self.writer.take() {
            writer.flush()?;
        }
        self.is_open = false;
        Ok(())
    }

    pub fn read_jsonl(path: impl AsRef<Path>) -> Result<Vec<Value>> {
        let data = std::fs::read_to_string(path.as_ref())
            .with_context(|| format!("failed to read {}", path.as_ref().display()))?;
        let mut events = Vec::new();
        for line in data.lines().filter(|line| !line.trim().is_empty()) {
            events.push(serde_json::from_str(line)?);
        }
        Ok(events)
    }
}

impl Drop for StreamingJsonlinesWriter {
    fn drop(&mut self) {
        if let Err(err) = self.close() {
            tracing::warn!("failed to close jsonlines writer: {err}");
        }
    }
}
