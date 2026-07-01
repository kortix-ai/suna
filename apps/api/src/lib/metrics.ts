import type { Effect } from 'effect';
// Dependency-free Prometheus exposition. Avoids prom-client (Node-oriented; its
// default-metric collectors are flaky under Bun) by maintaining a tiny in-memory
// registry and rendering the text format directly. Scope is the SLO signals:
// request rate, errors, and latency — plus event-loop lag and basic process gauges.

const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

type Labels = Record<string, string>;

function seriesKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabel(labels[k])}"`)
    .join(',');
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

class Counter {
  private values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels, by = 1): void {
    const key = seriesKey(labels);
    const cur = this.values.get(key);
    if (cur) cur.value += by;
    else this.values.set(key, { labels, value: by });
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}{${seriesKey(labels)}} ${value}`);
    }
    return lines.join('\n');
  }
}

class Gauge {
  private values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  set(value: number, labels: Labels = {}): void {
    this.values.set(seriesKey(labels), { labels, value });
  }
  inc(by = 1, labels: Labels = {}): void {
    const key = seriesKey(labels);
    const cur = this.values.get(key);
    if (cur) cur.value += by;
    else this.values.set(key, { labels, value: by });
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.values.values()) {
      const lbl = seriesKey(labels);
      lines.push(`${this.name}{${lbl}} ${value}`);
    }
    return lines.join('\n');
  }
}

class Histogram {
  private series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[] = DURATION_BUCKETS,
  ) {}
  observe(value: number, labels: Labels): void {
    const key = seriesKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.sum += value;
    s.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) s.counts[i] += 1;
    }
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      const base = seriesKey(s.labels);
      for (let i = 0; i < this.buckets.length; i++) {
        const le = `le="${this.buckets[i]}"`;
        lines.push(`${this.name}_bucket{${base ? base + ',' : ''}${le}} ${s.counts[i]}`);
      }
      lines.push(`${this.name}_bucket{${base ? base + ',' : ''}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum{${base}} ${s.sum}`);
      lines.push(`${this.name}_count{${base}} ${s.count}`);
    }
    return lines.join('\n');
  }
}

const httpRequestsTotal = new Counter(
  'http_requests_total',
  'Total HTTP requests by method, route and status code.',
);
const httpRequestDuration = new Histogram(
  'http_request_duration_seconds',
  'HTTP request latency in seconds by method and route.',
);
const httpRequestsInFlight = new Gauge(
  'http_requests_in_flight',
  'In-flight HTTP requests.',
);
const eventLoopLag = new Gauge(
  'nodejs_eventloop_lag_seconds',
  'Sampled event-loop lag in seconds.',
);
const processGauges = {
  rss: new Gauge('process_resident_memory_bytes', 'Resident memory size in bytes.'),
  uptime: new Gauge('process_uptime_seconds', 'Process uptime in seconds.'),
};

export function metricsEnabled(): boolean {
  return process.env.METRICS_ENABLED !== 'false';
}

export function recordHttpRequest(args: {
  method: string;
  route: string;
  status: number;
  durationSeconds: number;
}): void {
  if (!metricsEnabled()) return;
  const labels = { method: args.method, route: args.route, status: String(args.status) };
  httpRequestsTotal.inc(labels);
  httpRequestDuration.observe(args.durationSeconds, { method: args.method, route: args.route });
}

export function incInFlight(): void {
  if (metricsEnabled()) httpRequestsInFlight.inc(1);
}

export function decInFlight(): void {
  if (metricsEnabled()) httpRequestsInFlight.inc(-1);
}

export function setEventLoopLagSeconds(seconds: number): void {
  if (metricsEnabled()) eventLoopLag.set(seconds);
}

export function renderMetrics(): string {
  const mem = process.memoryUsage();
  processGauges.rss.set(mem.rss);
  processGauges.uptime.set(process.uptime());
  return (
    [
      httpRequestsTotal.render(),
      httpRequestDuration.render(),
      httpRequestsInFlight.render(),
      eventLoopLag.render(),
      processGauges.rss.render(),
      processGauges.uptime.render(),
    ].join('\n\n') + '\n'
  );
}
