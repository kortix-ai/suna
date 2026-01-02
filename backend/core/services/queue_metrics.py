"""
Queue metrics service for monitoring Temporal workflows.

Provides:
- Workflow metrics from Temporal Cloud
- CloudWatch publishing for ECS auto-scaling
"""
import asyncio
from datetime import datetime, timezone
from typing import Optional

from core.utils.logger import logger
from core.utils.config import config, EnvMode
from core.temporal.client import get_temporal_client

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
    Get Temporal workflow metrics.
    
    Returns:
        dict with running_workflows, pending_activities, timestamp
    """
    try:
        client = await get_temporal_client()
        
        # List running workflows (approximate count)
        # Note: Temporal Cloud provides metrics via their UI, but we can query workflows
        # For now, we'll return a simplified metric structure
        # In production, you might want to use Temporal's metrics API or CloudWatch integration
        
        # This is a placeholder - Temporal Cloud has built-in metrics
        # You can query workflows if needed, but it's more efficient to use Temporal's metrics
        return {
            "queue_name": "default",
            "running_workflows": 0,  # Placeholder - use Temporal Cloud metrics in production
            "pending_activities": 0,  # Placeholder
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "note": "Use Temporal Cloud metrics dashboard for accurate metrics"
        }
    except Exception as e:
        logger.error(f"Failed to get Temporal metrics: {e}")
        raise


async def publish_to_cloudwatch(workflow_count: int) -> bool:
    """
    Publish workflow count metric to CloudWatch for ECS auto-scaling.
    
    Args:
        workflow_count: Number of running workflows (approximate)
        
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
                'MetricName': 'TemporalWorkflowCount',
                'Value': workflow_count,
                'Unit': 'Count',
                'Dimensions': [
                    {'Name': 'Service', 'Value': 'worker'}
                ]
            }]
        )
        logger.debug(f"Published workflow count to CloudWatch: {workflow_count}")
        return True
    except Exception as e:
        logger.error(f"Failed to publish workflow metrics to CloudWatch: {e}")
        return False


async def start_cloudwatch_publisher(interval_seconds: int = 60):
    """
    Background task to publish workflow metrics to CloudWatch periodically.
    
    Args:
        interval_seconds: How often to publish (default 60s)
    """
    logger.info(f"Starting CloudWatch Temporal metrics publisher (interval: {interval_seconds}s)")
    
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            
            metrics = await get_queue_metrics()
            # Use running_workflows as approximate queue depth
            await publish_to_cloudwatch(metrics.get("running_workflows", 0))
            
        except asyncio.CancelledError:
            logger.info("CloudWatch Temporal metrics publisher stopped")
            raise
        except Exception as e:
            logger.error(f"Error in CloudWatch publisher loop: {e}")

