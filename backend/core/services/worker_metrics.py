"""
Worker metrics service for tracking Temporal workers.

Provides:
- Simplified worker metrics (Temporal Cloud has built-in metrics)
- CloudWatch publishing for monitoring
"""
import asyncio
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
    Get Temporal worker metrics.
    
    Note: Temporal Cloud provides comprehensive metrics via their dashboard.
    This function returns simplified metrics for CloudWatch integration.
    
    Returns:
        dict with active_workers, busy_threads, idle_threads, utilization, etc.
    """
    try:
        # Temporal workers have their own metrics system
        # For now, return placeholder metrics
        # In production, you can query Temporal Cloud's metrics API or use their CloudWatch integration
        
        # Placeholder values - replace with actual Temporal metrics if needed
        return {
            "active_workers": 0,  # Placeholder - use Temporal Cloud metrics
            "worker_count": 0,
            "total_threads": 0,
            "busy_threads": 0,
            "idle_threads": 0,
            "utilization_percent": 0.0,
            "in_progress_tasks": 0,
            "worker_details": [],
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "note": "Use Temporal Cloud metrics dashboard for accurate worker metrics"
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
