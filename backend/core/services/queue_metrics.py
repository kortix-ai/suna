"""
Queue metrics service for monitoring Redis Streams queue backlog.

Provides:
- Queue backlog (lag) metrics from Redis Streams consumer groups
- CloudWatch publishing for ECS auto-scaling

Key metrics:
- lag: Messages waiting to be delivered (queue backlog) - USE FOR SCALING
- pending: Messages being processed (not yet acknowledged)
"""
import asyncio
import os
from datetime import datetime, timezone
from typing import Optional

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


async def get_queue_metrics() -> dict:
    """
    Get Redis Streams queue metrics from consumer groups.
    
    Returns:
        dict with:
        - queue_backlog: Messages waiting to be delivered (lag) - USE FOR SCALING
        - in_progress: Messages being processed (pending)
        - per-stream details
    """
    from core.services import redis
    from core.worker.consumer import get_stream_info, CONSUMER_GROUP
    from core.worker.tasks import StreamName
    
    try:
        stream_info = await get_stream_info()
        
        total_lag = 0  # Queue backlog - waiting to be picked up
        total_pending = 0  # In progress - being processed
        stream_details = {}
        
        for stream_name in StreamName:
            stream_data = stream_info.get("streams", {}).get(stream_name.value, {})
            lag = stream_data.get("lag", 0)
            pending = stream_data.get("pending_count", 0)
            
            total_lag += lag
            total_pending += pending
            
            stream_details[stream_name.value] = {
                "lag": lag,  # Waiting in queue
                "pending": pending,  # Being processed
                "length": stream_data.get("length", 0),
            }
        
        return {
            "queue_backlog": total_lag,  # USE FOR SCALING - messages waiting
            "in_progress": total_pending,  # Messages being processed
            "pending_messages": total_pending,  # Deprecated alias
            "streams": stream_details,
            "consumer_group": CONSUMER_GROUP,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
    except Exception as e:
        logger.error(f"Failed to get Redis Streams metrics: {e}")
        raise


async def publish_to_cloudwatch(queue_backlog: int, in_progress: int) -> bool:
    """
    Publish Redis Streams metrics to CloudWatch for ECS auto-scaling.
    
    Args:
        queue_backlog: Number of messages waiting to be processed (lag) - PRIMARY SCALING METRIC
        in_progress: Number of messages currently being processed (pending)
        
    Returns:
        True if published successfully, False otherwise
    """
    cloudwatch = _get_cloudwatch_client()
    if cloudwatch is None:
        return False
    
    try:
        cloudwatch.put_metric_data(
            Namespace='Kortix',
            MetricData=[
                {
                    # PRIMARY SCALING METRIC - messages waiting in queue
                    'MetricName': 'RedisStreamsQueueBacklog',
                    'Value': queue_backlog,
                    'Unit': 'Count',
                    'Dimensions': [{'Name': 'Service', 'Value': 'worker'}]
                },
                {
                    # Tasks currently being processed
                    'MetricName': 'RedisStreamsInProgress',
                    'Value': in_progress,
                    'Unit': 'Count',
                    'Dimensions': [{'Name': 'Service', 'Value': 'worker'}]
                },
                {
                    # Deprecated - keep for backward compatibility during migration
                    'MetricName': 'RedisStreamsPendingMessages',
                    'Value': in_progress,
                    'Unit': 'Count',
                    'Dimensions': [{'Name': 'Service', 'Value': 'worker'}]
                }
            ]
        )
        logger.debug(f"Published Redis Streams metrics to CloudWatch: backlog={queue_backlog}, in_progress={in_progress}")
        return True
    except Exception as e:
        logger.error(f"Failed to publish Redis Streams metrics to CloudWatch: {e}")
        return False


async def start_cloudwatch_publisher(interval_seconds: int = 60):
    """
    Background task to publish Redis Streams metrics to CloudWatch periodically.
    
    Args:
        interval_seconds: How often to publish (default 60s)
    """
    logger.info(f"Starting CloudWatch Redis Streams metrics publisher (interval: {interval_seconds}s)")
    
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            
            metrics = await get_queue_metrics()
            await publish_to_cloudwatch(
                queue_backlog=metrics["queue_backlog"],
                in_progress=metrics["in_progress"]
            )
            
        except asyncio.CancelledError:
            logger.info("CloudWatch Redis Streams metrics publisher stopped")
            raise
        except Exception as e:
            logger.error(f"Error in CloudWatch publisher loop: {e}")

