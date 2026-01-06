"""
Worker metrics service for tracking active Redis Streams workers and task utilization.

Provides:
- Active consumer count from Redis Streams consumer groups
- Task utilization (busy vs idle concurrent tasks)
- Consumer health tracking via pending messages
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
    Get active consumer count and task utilization from Redis Streams consumer groups.
    
    Redis Streams stores:
    - Consumer groups: one per stream (suna-workers)
    - Consumers: each worker container registers as a consumer
    - Pending messages: unacknowledged messages per consumer
    
    Returns:
        dict with active_workers (consumers), busy_tasks, idle_tasks, utilization, etc.
    """
    from core.worker.consumer import get_stream_info, CONSUMER_GROUP
    from core.worker.tasks import StreamName
    
    try:
        # Configuration: concurrency per worker container
        # Each ECS task runs: `python run_worker.py --concurrency 48`
        # Each container is a consumer in the consumer group
        WORKER_CONCURRENCY = int(os.getenv("STREAM_WORKER_CONCURRENCY", "48"))
        
        stream_info = await get_stream_info()
        
        # Collect all unique consumers across all streams
        all_consumers = {}  # consumer_name -> {pending, idle_ms, streams}
        total_pending = 0
        total_length = 0
        
        for stream_name in StreamName:
            stream_data = stream_info.get("streams", {}).get(stream_name.value, {})
            total_length += stream_data.get("length", 0)
            
            # Get consumers for this stream
            consumers = stream_data.get("consumers", [])
            for consumer in consumers:
                consumer_name = consumer.get("name", "unknown")
                pending = consumer.get("pending", 0)
                idle_ms = consumer.get("idle_ms", 0)
                
                if consumer_name not in all_consumers:
                    all_consumers[consumer_name] = {
                        "pending": 0,
                        "max_idle_ms": 0,
                        "streams": []
                    }
                
                all_consumers[consumer_name]["pending"] += pending
                all_consumers[consumer_name]["max_idle_ms"] = max(
                    all_consumers[consumer_name]["max_idle_ms"],
                    idle_ms
                )
                all_consumers[consumer_name]["streams"].append(stream_name.value)
                total_pending += pending
        
        active_worker_count = len(all_consumers)
        
        # Calculate task utilization
        # Each worker has WORKER_CONCURRENCY concurrent task slots
        total_task_slots = active_worker_count * WORKER_CONCURRENCY
        
        # Calculate busy_tasks per consumer (capped at concurrency limit)
        # A consumer can't have more busy tasks than its concurrency limit
        busy_tasks = 0
        worker_details = []
        for consumer_name, data in all_consumers.items():
            # Cap busy tasks at concurrency - pending may exceed this if tasks are stuck
            consumer_busy = min(data["pending"], WORKER_CONCURRENCY)
            consumer_idle = max(0, WORKER_CONCURRENCY - consumer_busy)
            busy_tasks += consumer_busy
            
            worker_details.append({
                "consumer_name": consumer_name[:32] + "..." if len(consumer_name) > 32 else consumer_name,
                "pending_messages": data["pending"],
                "idle_ms": data["max_idle_ms"],
                "idle_seconds": round(data["max_idle_ms"] / 1000, 2),
                "busy_tasks": consumer_busy,
                "idle_tasks": consumer_idle,
                "stuck_tasks": max(0, data["pending"] - WORKER_CONCURRENCY),  # Tasks beyond capacity
                "streams": data["streams"]
            })
        
        idle_tasks = max(0, total_task_slots - busy_tasks)
        utilization_percent = (busy_tasks / total_task_slots * 100) if total_task_slots > 0 else 0
        
        return {
            "active_workers": active_worker_count,
            "worker_count": active_worker_count,  # Alias for consistency
            "total_task_slots": total_task_slots,
            "busy_tasks": busy_tasks,
            "idle_tasks": idle_tasks,
            "busy_threads": busy_tasks,  # Alias for backward compatibility
            "idle_threads": idle_tasks,  # Alias for backward compatibility
            "utilization_percent": round(utilization_percent, 2),
            "in_progress_tasks": busy_tasks,  # Alias for backward compatibility
            "tasks_per_worker": WORKER_CONCURRENCY,
            "total_pending_messages": total_pending,  # Total unacknowledged (includes stuck)
            "total_stream_length": total_length,
            "stuck_tasks": max(0, total_pending - busy_tasks),  # Tasks beyond capacity
            "worker_details": worker_details,
            "consumer_group": CONSUMER_GROUP,
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
