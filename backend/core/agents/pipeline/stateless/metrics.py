import asyncio
import time
from dataclasses import dataclass, field
from typing import Dict, Any, List, Optional
from collections import deque

from core.agents.pipeline.stateless.config import config as stateless_config

class AsyncCounter:
    def __init__(self, name: str):
        self.name = name
        self._value: int = 0
        self._lock = asyncio.Lock()

    async def inc(self, n: int = 1) -> None:
        async with self._lock:
            self._value += n

    def inc_sync(self, n: int = 1) -> None:
        self._value += n

    def get(self) -> int:
        return self._value


class AsyncGauge:
    def __init__(self, name: str):
        self.name = name
        self._value: float = 0.0
        self._lock = asyncio.Lock()

    async def set(self, v: float) -> None:
        async with self._lock:
            self._value = v

    def set_sync(self, v: float) -> None:
        self._value = v

    async def inc(self, n: float = 1.0) -> None:
        async with self._lock:
            self._value += n

    async def dec(self, n: float = 1.0) -> None:
        async with self._lock:
            self._value -= n

    def get(self) -> float:
        return self._value


class AsyncHistogram:
    def __init__(
        self,
        name: str,
        buckets: Optional[List[float]] = None,
        maxlen: int = 1000,
    ):
        self.name = name
        self.buckets = buckets or [0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0, 30.0, 60.0]
        self._observations: deque = deque(maxlen=maxlen)
        self._lock = asyncio.Lock()
        self._sum: float = 0.0
        self._count: int = 0

    async def observe(self, v: float) -> None:
        async with self._lock:
            self._observations.append(v)
            self._sum += v
            self._count += 1

    def observe_sync(self, v: float) -> None:
        self._observations.append(v)
        self._sum += v
        self._count += 1

    def count(self) -> int:
        return self._count

    def sum(self) -> float:
        return self._sum

    def avg(self) -> float:
        return self._sum / self._count if self._count > 0 else 0.0

    def percentile(self, p: float) -> float:
        if not self._observations:
            return 0.0
        s = sorted(self._observations)
        i = int(len(s) * p / 100)
        return s[min(i, len(s) - 1)]

    def get_bucket_counts(self) -> Dict[str, int]:
        counts = {str(b): 0 for b in self.buckets}
        counts["+Inf"] = 0

        for v in self._observations:
            for b in self.buckets:
                if v <= b:
                    counts[str(b)] += 1
                    break
            else:
                counts["+Inf"] += 1

        return counts


@dataclass
class Counter:
    name: str
    value: int = 0

    def inc(self, n: int = 1) -> None:
        self.value += n

    def get(self) -> int:
        return self.value


@dataclass
class Gauge:
    name: str
    value: float = 0.0

    def set(self, v: float) -> None:
        self.value = v

    def inc(self, n: float = 1.0) -> None:
        self.value += n

    def dec(self, n: float = 1.0) -> None:
        self.value -= n

    def get(self) -> float:
        return self.value


@dataclass
class Histogram:
    name: str
    buckets: List[float] = field(default_factory=lambda: [0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0, 30.0, 60.0])
    observations: deque = field(default_factory=lambda: deque(maxlen=1000))

    def observe(self, v: float) -> None:
        self.observations.append(v)

    def count(self) -> int:
        return len(self.observations)

    def sum(self) -> float:
        return sum(self.observations)

    def avg(self) -> float:
        return self.sum() / self.count() if self.observations else 0.0

    def percentile(self, p: float) -> float:
        if not self.observations:
            return 0.0
        s = sorted(self.observations)
        i = int(len(s) * p / 100)
        return s[min(i, len(s) - 1)]


class Metrics:
    def __init__(self):
        self.active_runs = Gauge("suna_active_runs")
        self.owned_runs = Gauge("suna_owned_runs")
        self.pending_writes = Gauge("suna_pending_writes")

        self.flush_tasks_active = Gauge("suna_flush_tasks_active")
        self.thread_locks_count = Gauge("suna_thread_locks_count")
        self.memory_messages_count = Gauge("suna_memory_messages_count")
        
        # Heartbeat health gauges
        self.heartbeat_critical_runs = Gauge("suna_heartbeat_critical_runs")
        self.heartbeat_warning_runs = Gauge("suna_heartbeat_warning_runs")
        self.heartbeat_healthy_runs = Gauge("suna_heartbeat_healthy_runs")
        self.heartbeat_worst_age_seconds = Gauge("suna_heartbeat_worst_age_seconds")

        self.runs_started = Counter("suna_runs_started")
        self.runs_completed = Counter("suna_runs_completed")
        self.runs_failed = Counter("suna_runs_failed")
        self.runs_recovered = Counter("suna_runs_recovered")
        self.runs_rejected = Counter("suna_runs_rejected")
        self.writes_flushed = Counter("suna_writes_flushed")
        self.writes_dropped = Counter("suna_writes_dropped")
        self.wal_appends = Counter("suna_wal_appends")
        self.dlq_entries = Counter("suna_dlq_entries")
        self.heartbeat_failures = Counter("suna_heartbeat_failures")

        self.run_duration = Histogram("suna_run_duration_seconds", [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600])
        self.flush_latency = Histogram("suna_flush_latency_seconds", [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0])
        self.step_latency = Histogram("suna_step_latency_seconds", [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0])

        self._async_active_runs = AsyncGauge("suna_active_runs_async")
        self._async_pending_writes = AsyncGauge("suna_pending_writes_async")
        self._async_flush_latency = AsyncHistogram("suna_flush_latency_async")

    def record_run_started(self) -> None:
        self.runs_started.inc()
        self.active_runs.inc()

    def record_run_completed(self, duration: float) -> None:
        self.runs_completed.inc()
        self.active_runs.dec()
        self.run_duration.observe(duration)

    def record_run_failed(self, duration: float) -> None:
        self.runs_failed.inc()
        self.active_runs.dec()
        self.run_duration.observe(duration)

    def record_run_rejected(self) -> None:
        self.runs_rejected.inc()

    def record_run_recovered(self) -> None:
        self.runs_recovered.inc()

    def record_writes_flushed(self, count: int, latency: float) -> None:
        self.writes_flushed.inc(count)
        self.flush_latency.observe(latency)

    def record_step(self, latency: float) -> None:
        self.step_latency.observe(latency)

    def record_wal_append(self) -> None:
        self.wal_appends.inc()

    def record_dlq_entry(self) -> None:
        self.dlq_entries.inc()

    def record_heartbeat_failure(self) -> None:
        self.heartbeat_failures.inc()

    def update_heartbeat_health(self, healthy: int, warning: int, critical: int, worst_age: float) -> None:
        """Update heartbeat health gauges."""
        self.heartbeat_healthy_runs.set(healthy)
        self.heartbeat_warning_runs.set(warning)
        self.heartbeat_critical_runs.set(critical)
        self.heartbeat_worst_age_seconds.set(worst_age)

    def update_buffer(self, pending: int) -> None:
        self.pending_writes.set(pending)

    def update_ownership(self, owned: int) -> None:
        self.owned_runs.set(owned)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "active_runs": self.active_runs.get(),
            "owned_runs": self.owned_runs.get(),
            "pending_writes": self.pending_writes.get(),
            "flush_tasks_active": self.flush_tasks_active.get(),
            "thread_locks_count": self.thread_locks_count.get(),
            "memory_messages_count": self.memory_messages_count.get(),
            "runs_started": self.runs_started.get(),
            "runs_completed": self.runs_completed.get(),
            "runs_failed": self.runs_failed.get(),
            "runs_recovered": self.runs_recovered.get(),
            "runs_rejected": self.runs_rejected.get(),
            "writes_flushed": self.writes_flushed.get(),
            "writes_dropped": self.writes_dropped.get(),
            "wal_appends": self.wal_appends.get(),
            "dlq_entries": self.dlq_entries.get(),
            "heartbeat_failures": self.heartbeat_failures.get(),
            "heartbeat_critical_runs": self.heartbeat_critical_runs.get(),
            "heartbeat_warning_runs": self.heartbeat_warning_runs.get(),
            "heartbeat_healthy_runs": self.heartbeat_healthy_runs.get(),
            "heartbeat_worst_age_seconds": self.heartbeat_worst_age_seconds.get(),
            "run_duration_avg": self.run_duration.avg(),
            "run_duration_p99": self.run_duration.percentile(99),
            "flush_latency_avg": self.flush_latency.avg(),
            "flush_latency_p99": self.flush_latency.percentile(99),
            "step_latency_avg": self.step_latency.avg(),
            "step_latency_p99": self.step_latency.percentile(99),
        }

    def to_prometheus(self) -> str:
        lines = []

        for g in [self.active_runs, self.owned_runs, self.pending_writes]:
            lines.append(f"# TYPE {g.name} gauge")
            lines.append(f"{g.name} {g.get()}")

        counters = [
            self.runs_started, self.runs_completed, self.runs_failed,
            self.runs_recovered, self.runs_rejected, self.writes_flushed,
            self.writes_dropped, self.wal_appends, self.dlq_entries,
        ]
        for c in counters:
            lines.append(f"# TYPE {c.name} counter")
            lines.append(f"{c.name} {c.get()}")

        for h in [self.run_duration, self.flush_latency, self.step_latency]:
            lines.append(f"# TYPE {h.name} histogram")
            lines.append(f"{h.name}_count {h.count()}")
            lines.append(f"{h.name}_sum {h.sum()}")

        return "\n".join(lines)

    def check_health(self) -> Dict[str, Any]:
        alerts = []

        if self.pending_writes.get() > stateless_config.PENDING_WRITES_WARNING_THRESHOLD:
            alerts.append({
                "level": "warning",
                "metric": "pending_writes",
                "value": self.pending_writes.get(),
            })

        if self.flush_latency.percentile(99) > stateless_config.FLUSH_LATENCY_WARNING_THRESHOLD_SECONDS:
            alerts.append({
                "level": "warning",
                "metric": "flush_latency_p99",
                "value": self.flush_latency.percentile(99),
            })

        if self.active_runs.get() > stateless_config.ACTIVE_RUNS_WARNING_THRESHOLD:
            alerts.append({
                "level": "warning",
                "metric": "active_runs",
                "value": self.active_runs.get(),
            })

        if self.flush_tasks_active.get() > stateless_config.MAX_FLUSH_TASKS:
            alerts.append({
                "level": "critical",
                "metric": "flush_tasks_leak",
                "value": self.flush_tasks_active.get(),
            })

        if self.thread_locks_count.get() > stateless_config.MAX_THREAD_LOCKS * 0.9:
            alerts.append({
                "level": "warning",
                "metric": "thread_locks_high",
                "value": self.thread_locks_count.get(),
            })

        if self.writes_dropped.get() > 0:
            alerts.append({
                "level": "critical",
                "metric": "writes_dropped",
                "value": self.writes_dropped.get(),
            })

        if self.dlq_entries.get() > 0:
            alerts.append({
                "level": "warning",
                "metric": "dlq_entries",
                "value": self.dlq_entries.get(),
            })

        # Heartbeat health alerts
        if self.heartbeat_critical_runs.get() > 0:
            alerts.append({
                "level": "critical",
                "metric": "heartbeat_critical_runs",
                "value": self.heartbeat_critical_runs.get(),
                "message": f"{int(self.heartbeat_critical_runs.get())} runs at risk of orphan takeover",
            })
        
        if self.heartbeat_warning_runs.get() > 0:
            alerts.append({
                "level": "warning",
                "metric": "heartbeat_warning_runs",
                "value": self.heartbeat_warning_runs.get(),
                "message": f"{int(self.heartbeat_warning_runs.get())} runs with degraded heartbeats",
            })

        critical_alerts = [a for a in alerts if a.get("level") == "critical"]

        return {
            "healthy": len(critical_alerts) == 0,
            "alerts": alerts,
            "metrics": self.to_dict(),
        }


metrics = Metrics()
