"""
Worker metrics service for tracking active Dramatiq workers and thread utilization.

Provides:
- Active worker count from Redis (Dramatiq worker registry)
- Worker thread utilization (busy vs idle threads)
- Worker health/heartbeat tracking
- CloudWatch publishing for monitoring
"""
import asyncio
import os
from datetime import datetime, timezone
from typing import Optional, Dict, List

from core.utils.logger import logger
from core.utils.config import config, EnvMode

# CloudWatch client (lazy initialized)
_cloudwatch_client = None


def _get_cloudwatch_client():
    """Get or create CloudWatch client (production only)."""
    global _cloudwatch_client
    
    if config.ENV_MODE != EnvMode.PRODUCTION:
        return None
        
    if _cloudwatch_client is None:
        try:
            import boto3
            _cloudwatch_client = boto3.client('cloudwatch', region_name='us-west-2')
        except Exception as e:
            logger.warning(f"Failed to initialize CloudWatch client: {e}")
            return None
    
    return _cloudwatch_client


async def get_worker_metrics() -> dict:
    """
    Get active worker count and thread utilization from Dramatiq worker registry in Redis.
    
    Dramatiq stores:
    - Worker heartbeats: dramatiq:__heartbeats__ (sorted set: score=timestamp, member=worker_id)
    - In-progress tasks: dramatiq:__acks__.{worker_id}.{queue_name} (sets of message IDs)
    
    Returns:
        dict with active_workers, busy_threads, idle_threads, utilization, etc.
    """
    from core.services import redis
    import time
    
    try:
        client = await redis.get_client()
        
        # Configuration: threads per worker process
        # From ECS config: 8 processes × 12 threads = 96 threads per worker task
        WORKER_PROCESSES = int(os.getenv("WORKER_PROCESSES", "8"))
        WORKER_THREADS = int(os.getenv("WORKER_THREADS", "12"))
        THREADS_PER_WORKER_TASK = WORKER_PROCESSES * WORKER_THREADS
        
        # Dramatiq uses a sorted set for worker heartbeats
        # Key: dramatiq:__heartbeats__
        # Format: sorted set where score = timestamp (ms), member = worker_id (broker_id)
        heartbeat_key = "dramatiq:__heartbeats__"
        
        # Get current timestamp in milliseconds
        current_time_ms = int(time.time() * 1000)
        
        # Dramatiq default heartbeat timeout is 60 seconds (60000 ms)
        # Workers are considered active if heartbeat is within last 60 seconds
        heartbeat_timeout_ms = 60000
        min_timestamp = current_time_ms - heartbeat_timeout_ms
        
        # Get all workers with heartbeats within the timeout window
        # ZRANGEBYSCORE returns members with scores >= min_timestamp
        active_worker_ids = await client.zrangebyscore(
            heartbeat_key,
            min=min_timestamp,
            max="+inf"
        )
        
        # Decode bytes to strings if needed
        if active_worker_ids and isinstance(active_worker_ids[0], bytes):
            active_worker_ids = [wid.decode('utf-8') if isinstance(wid, bytes) else wid for wid in active_worker_ids]
        
        active_worker_count = len(active_worker_ids)
        
        # Count in-progress tasks (busy threads)
        # Dramatiq stores in-progress messages in sets: dramatiq:__acks__.{worker_id}.{queue_name}
        total_in_progress_tasks = 0
        worker_task_counts = {}
        
        for worker_id in active_worker_ids:
            # Find all ack sets for this worker
            ack_pattern = f"dramatiq:__acks__.{worker_id}.*"
            ack_keys = await client.keys(ack_pattern)
            
            worker_tasks = 0
            for ack_key in ack_keys:
                if isinstance(ack_key, bytes):
                    ack_key = ack_key.decode('utf-8')
                # Count messages in this ack set (these are in-progress)
                task_count = await client.scard(ack_key)
                worker_tasks += task_count
            
            worker_task_counts[worker_id] = worker_tasks
            total_in_progress_tasks += worker_tasks
        
        # Calculate thread utilization
        total_threads = active_worker_count * THREADS_PER_WORKER_TASK
        busy_threads = total_in_progress_tasks
        idle_threads = max(0, total_threads - busy_threads)
        utilization_percent = (busy_threads / total_threads * 100) if total_threads > 0 else 0
        
        # Get worker details (optional, for debugging)
        worker_details = []
        for worker_id in active_worker_ids[:5]:  # Limit to first 5 for performance
            try:
                # Get heartbeat timestamp for this worker
                score = await client.zscore(heartbeat_key, worker_id)
                if score is not None:
                    heartbeat_age_ms = current_time_ms - int(score)
                    worker_details.append({
                        "worker_id": worker_id[:16] + "...",  # Truncate for readability
                        "last_heartbeat_ms": int(score),
                        "heartbeat_age_seconds": round(heartbeat_age_ms / 1000, 2),
                        "busy_threads": worker_task_counts.get(worker_id, 0),
                        "idle_threads": max(0, THREADS_PER_WORKER_TASK - worker_task_counts.get(worker_id, 0))
                    })
            except Exception as e:
                logger.debug(f"Failed to get details for worker {worker_id}: {e}")
        
        return {
            "active_workers": active_worker_count,
            "worker_count": active_worker_count,  # Alias for consistency
            "total_threads": total_threads,
            "busy_threads": busy_threads,
            "idle_threads": idle_threads,
            "utilization_percent": round(utilization_percent, 2),
            "in_progress_tasks": total_in_progress_tasks,
            "threads_per_worker_task": THREADS_PER_WORKER_TASK,
            "worker_details": worker_details,
            "heartbeat_timeout_seconds": heartbeat_timeout_ms / 1000,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
    except Exception as e:
        logger.error(f"Failed to get worker metrics: {e}")
        raise


async def get_worker_count() -> int:
    """
    Get just the active worker count (simplified version).
    
    Returns:
        Number of active workers
    """
    try:
        metrics = await get_worker_metrics()
        return metrics["active_workers"]
    except Exception as e:
        logger.error(f"Failed to get worker count: {e}")
        return 0


async def publish_to_cloudwatch(metrics: dict) -> bool:
    """
    Publish worker metrics to CloudWatch for monitoring.
    
    Args:
        metrics: Worker metrics dict from get_worker_metrics()
        
    Returns:
        True if published successfully, False otherwise
    """
    cloudwatch = _get_cloudwatch_client()
    if cloudwatch is None:
        return False
    
    try:
        metric_data = [
            {
                'MetricName': 'ActiveWorkerCount',
                'Value': metrics.get('active_workers', 0),
                'Unit': 'Count',
                'Dimensions': [{'Name': 'Service', 'Value': 'worker'}]
            },
            {
                'MetricName': 'BusyWorkerThreads',
                'Value': metrics.get('busy_threads', 0),
                'Unit': 'Count',
                'Dimensions': [{'Name': 'Service', 'Value': 'worker'}]
            },
            {
                'MetricName': 'IdleWorkerThreads',
                'Value': metrics.get('idle_threads', 0),
                'Unit': 'Count',
                'Dimensions': [{'Name': 'Service', 'Value': 'worker'}]
            },
            {
                'MetricName': 'WorkerThreadUtilization',
                'Value': metrics.get('utilization_percent', 0),
                'Unit': 'Percent',
                'Dimensions': [{'Name': 'Service', 'Value': 'worker'}]
            },
            {
                'MetricName': 'InProgressTasks',
                'Value': metrics.get('in_progress_tasks', 0),
                'Unit': 'Count',
                'Dimensions': [{'Name': 'Service', 'Value': 'worker'}]
            }
        ]
        
        cloudwatch.put_metric_data(
            Namespace='Kortix',
            MetricData=metric_data
        )
        logger.debug(f"Published worker metrics to CloudWatch: {metrics.get('active_workers')} workers, {metrics.get('busy_threads')}/{metrics.get('total_threads')} threads busy ({metrics.get('utilization_percent')}%)")
        return True
    except Exception as e:
        logger.error(f"Failed to publish worker metrics to CloudWatch: {e}")
        return False


async def start_cloudwatch_publisher(interval_seconds: int = 60):
    """
    Background task to publish worker metrics to CloudWatch periodically.
    
    Args:
        interval_seconds: How often to publish (default 60s)
    """
    logger.info(f"Starting CloudWatch worker metrics publisher (interval: {interval_seconds}s)")
    
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            
            metrics = await get_worker_metrics()
            await publish_to_cloudwatch(metrics)
            
        except asyncio.CancelledError:
            logger.info("CloudWatch worker metrics publisher stopped")
            raise
        except Exception as e:
            logger.error(f"Error in CloudWatch worker publisher loop: {e}")
