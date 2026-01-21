#!/usr/bin/env python3
"""
WAL Health Check Script
Run this to check if you should worry about WAL status
"""

import asyncio
from core.agents.pipeline.stateless.metrics import metrics
from core.agents.pipeline.stateless.persistence.wal import wal
from core.agents.pipeline.stateless.resilience.backpressure import backpressure
from core.agents.pipeline.stateless.config import config


async def check_wal_health():
    """Check WAL health and return status"""
    
    # Get metrics
    wal_stats = await wal.get_stats()
    metrics_dict = metrics.to_dict()
    backpressure_state = await backpressure.update_metrics(
        pending_writes=metrics_dict["pending_writes"],
        active_runs=metrics_dict["active_runs"],
        flush_latency_ms=metrics_dict.get("flush_latency_p99", 0) * 1000,
    )
    
    issues = []
    warnings = []
    info = []
    
    # CRITICAL CHECKS
    if metrics_dict["dlq_entries"] > 0:
        issues.append(f"🚨 CRITICAL: {metrics_dict['dlq_entries']} entries in DLQ - data loss risk!")
    
    if metrics_dict["writes_dropped"] > 0:
        issues.append(f"🚨 CRITICAL: {metrics_dict['writes_dropped']} writes dropped - data loss confirmed!")
    
    if metrics_dict["heartbeat_critical_runs"] > 0:
        issues.append(f"🚨 CRITICAL: {metrics_dict['heartbeat_critical_runs']} runs at risk of orphan takeover!")
    
    # WARNING CHECKS
    if wal_stats["total_pending"] > 1000:
        warnings.append(f"⚠️  WARNING: {wal_stats['total_pending']} pending entries (threshold: 1000)")
    
    if wal_stats["runs_with_pending"] > 50:
        warnings.append(f"⚠️  WARNING: {wal_stats['runs_with_pending']} runs with pending writes (threshold: 50)")
    
    if metrics_dict.get("flush_latency_p99", 0) > 10.0:
        warnings.append(f"⚠️  WARNING: Flush latency P99 is {metrics_dict['flush_latency_p99']:.2f}s (threshold: 10s)")
    
    if backpressure_state.level.value == "critical":
        warnings.append(f"⚠️  WARNING: Backpressure level is CRITICAL - system overloaded")
    
    if wal_stats["local_buffer_runs"] > 0:
        warnings.append(f"⚠️  WARNING: {wal_stats['local_buffer_runs']} runs using local buffer (Redis issues)")
    
    if metrics_dict["pending_writes"] > config.PENDING_WRITES_WARNING_THRESHOLD:
        warnings.append(f"⚠️  WARNING: {metrics_dict['pending_writes']} pending writes (threshold: {config.PENDING_WRITES_WARNING_THRESHOLD})")
    
    if metrics_dict["active_runs"] > config.ACTIVE_RUNS_WARNING_THRESHOLD:
        warnings.append(f"⚠️  WARNING: {metrics_dict['active_runs']} active runs (threshold: {config.ACTIVE_RUNS_WARNING_THRESHOLD})")
    
    # INFO
    info.append(f"✅ Total pending: {wal_stats['total_pending']}")
    info.append(f"✅ Runs w/ pending: {wal_stats['runs_with_pending']}")
    info.append(f"✅ Local buffer: {wal_stats.get('local_buffer_runs', 0)}")
    info.append(f"✅ Active runs: {metrics_dict['active_runs']}")
    info.append(f"✅ Pending writes: {metrics_dict['pending_writes']}")
    info.append(f"✅ Flush latency P99: {metrics_dict.get('flush_latency_p99', 0):.2f}s")
    info.append(f"✅ Backpressure level: {backpressure_state.level.value}")
    info.append(f"✅ DLQ entries: {metrics_dict['dlq_entries']}")
    info.append(f"✅ Writes dropped: {metrics_dict['writes_dropped']}")
    info.append(f"✅ Heartbeat critical: {metrics_dict['heartbeat_critical_runs']}")
    
    # Print results
    print("=" * 60)
    print("WAL HEALTH CHECK")
    print("=" * 60)
    
    if issues:
        print("\n🚨 CRITICAL ISSUES (ACT NOW):")
        for issue in issues:
            print(f"  {issue}")
    
    if warnings:
        print("\n⚠️  WARNINGS (INVESTIGATE SOON):")
        for warning in warnings:
            print(f"  {warning}")
    
    if not issues and not warnings:
        print("\n✅ ALL SYSTEMS HEALTHY")
    
    print("\n📊 CURRENT METRICS:")
    for item in info:
        print(f"  {item}")
    
    print("\n" + "=" * 60)
    
    # Return status
    if issues:
        return "CRITICAL"
    elif warnings:
        return "WARNING"
    else:
        return "HEALTHY"


if __name__ == "__main__":
    status = asyncio.run(check_wal_health())
    exit(0 if status == "HEALTHY" else 1)
