use crate::{processor::RealTimeEventProcessor, utils::Event};
use anyhow::Result;
use parking_lot::Mutex;
use serde_json::Value;
use std::{cmp::Ordering, sync::Arc};

#[derive(Debug, Clone)]
pub struct TimestampReorderedProcessor {
    state: Arc<Mutex<ReorderState>>,
}

#[derive(Debug)]
struct ReorderState {
    processor: RealTimeEventProcessor,
    window_seconds: f64,
    max_events: usize,
    max_seen_timestamp: Option<f64>,
    next_sequence: u64,
    buffer: Vec<BufferedEvent>,
}

#[derive(Debug)]
struct BufferedEvent {
    timestamp: f64,
    sequence: u64,
    event: Event,
}

impl TimestampReorderedProcessor {
    pub const DEFAULT_WINDOW_SECONDS: f64 = 10.0;
    pub const DEFAULT_MAX_EVENTS: usize = 1024;

    pub fn new(processor: RealTimeEventProcessor) -> Self {
        Self::with_limits(
            processor,
            Self::DEFAULT_WINDOW_SECONDS,
            Self::DEFAULT_MAX_EVENTS,
        )
    }

    pub fn with_limits(
        processor: RealTimeEventProcessor,
        window_seconds: f64,
        max_events: usize,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(ReorderState::new(
                processor,
                window_seconds,
                max_events,
            ))),
        }
    }

    pub fn add_event(&self, event: Event) -> Result<()> {
        let mut state = self.state.lock();
        let ready = state.push(event);
        state.dispatch(ready)
    }

    pub fn flush(&self) -> Result<()> {
        let mut state = self.state.lock();
        let ready = state.drain_all();
        state.dispatch(ready)
    }

    pub fn flush_writers(&self) -> Result<()> {
        self.state.lock().processor.flush_writers()
    }

    pub fn stop(&self) -> Result<()> {
        let mut state = self.state.lock();
        let ready = state.drain_all();
        state.dispatch(ready)?;
        state.processor.stop()
    }
}

impl ReorderState {
    fn new(processor: RealTimeEventProcessor, window_seconds: f64, max_events: usize) -> Self {
        Self {
            processor,
            window_seconds: window_seconds.max(0.0),
            max_events: max_events.max(1),
            max_seen_timestamp: None,
            next_sequence: 0,
            buffer: Vec::new(),
        }
    }

    fn push(&mut self, event: Event) -> Vec<Event> {
        let Some(timestamp) = event.get("timestamp").and_then(Value::as_f64) else {
            let mut ready = self.drain_all();
            ready.push(event);
            return ready;
        };

        self.max_seen_timestamp = Some(
            self.max_seen_timestamp
                .map(|max_seen| max_seen.max(timestamp))
                .unwrap_or(timestamp),
        );
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.wrapping_add(1);
        self.buffer.push(BufferedEvent {
            timestamp,
            sequence,
            event,
        });
        self.drain_ready()
    }

    fn drain_ready(&mut self) -> Vec<Event> {
        self.sort_buffer();

        let watermark = self
            .max_seen_timestamp
            .map(|max_seen| max_seen - self.window_seconds)
            .unwrap_or(f64::NEG_INFINITY);
        let mut drain_count = self
            .buffer
            .iter()
            .take_while(|entry| entry.timestamp <= watermark)
            .count();

        if self.buffer.len().saturating_sub(drain_count) > self.max_events {
            drain_count = drain_count.max(self.buffer.len() - self.max_events);
        }

        self.buffer
            .drain(..drain_count)
            .map(|entry| entry.event)
            .collect()
    }

    fn drain_all(&mut self) -> Vec<Event> {
        self.sort_buffer();
        self.buffer.drain(..).map(|entry| entry.event).collect()
    }

    fn dispatch(&mut self, ready: Vec<Event>) -> Result<()> {
        for event in ready {
            self.processor.add_event(event)?;
        }
        Ok(())
    }

    fn sort_buffer(&mut self) {
        self.buffer.sort_by(|a, b| {
            a.timestamp
                .partial_cmp(&b.timestamp)
                .unwrap_or(Ordering::Equal)
                .then_with(|| a.sequence.cmp(&b.sequence))
        });
    }
}
