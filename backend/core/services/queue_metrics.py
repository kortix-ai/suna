"""
Queue metrics service for monitoring Dramatiq queue depth.

Provides:
- Queue depth metrics from Redis
- CloudWatch publishing for ECS auto-scaling
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
    Get Dramatiq queue metrics from Redis.
    
    Returns:
        dict with queue_depth, delay_queue_depth, dead_letter_depth, timestamp
    """
    from core.services import redis
    
    try:
        queue_depth = await redis.llen("dramatiq:default")
        delay_queue_depth = await redis.llen("dramatiq:default.DQ")
        dead_letter_depth = await redis.llen("dramatiq:default.XQ")
        
        return {
            "queue_depth": queue_depth,
            "delay_queue_depth": delay_queue_depth,
            "dead_letter_depth": dead_letter_depth,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
    except Exception as e:
        logger.error(f"Failed to get queue metrics: {e}")
        raise


async def publish_to_cloudwatch(queue_depth: int) -> bool:
    """
    Publish queue depth metric to CloudWatch for ECS auto-scaling.
    
    Args:
        queue_depth: Number of jobs in the queue
        
    Returns:
        True if published successfully, False otherwise
    """
    cloudwatch = _get_cloudwatch_client()
    if cloudwatch is None:
        return False
    
    try:
        cloudwatch.put_metric_data(
            Namespace='Kortix',
            MetricData=[{
                'MetricName': 'DramatiqQueueDepth',
                'Value': queue_depth,
                'Unit': 'Count',
                'Dimensions': [
                    {'Name': 'Service', 'Value': 'worker'}
                ]
            }]
        )
        logger.debug(f"Published queue depth to CloudWatch: {queue_depth}")
        return True
    except Exception as e:
        logger.error(f"Failed to publish queue metrics to CloudWatch: {e}")
        return False


async def start_cloudwatch_publisher(interval_seconds: int = 60):
    """
    Background task to publish queue depth to CloudWatch periodically.
    
    Args:
        interval_seconds: How often to publish (default 60s)
    """
    logger.info(f"Starting CloudWatch queue metrics publisher (interval: {interval_seconds}s)")
    
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            
            metrics = await get_queue_metrics()
            await publish_to_cloudwatch(metrics["queue_depth"])
            
        except asyncio.CancelledError:
            logger.info("CloudWatch queue metrics publisher stopped")
            raise
        except Exception as e:
            logger.error(f"Error in CloudWatch publisher loop: {e}")

