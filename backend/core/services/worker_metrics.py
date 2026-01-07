"""
API instance metrics service for tracking concurrent agent runs and background tasks.

Provides:
- API instance concurrency metrics (agent runs executing directly)
- Background task metrics (memory/categorization via Redis Streams)
- CloudWatch publishing for monitoring

Note: Agent runs execute directly in API process with semaphore control.
Only memory/categorization tasks use Redis Streams.
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
    Get real API instance metrics with actual active agent run counts.
    
    Returns:
        dict with:
        - active_agent_runs: Total active runs across all instances (from DB)
        - active_redis_streams: Active Redis stream keys (real-time tracking)
        - current_instance_runs: Runs on this instance (from semaphore)
        - max_concurrent_runs: Maximum concurrent runs per instance
        - utilization_percent: Current utilization
    """
    from core.agents.runs import MAX_CONCURRENT_RUNS, _run_semaphore
    from core.services.supabase import DBConnection
    from core.services import redis
    
    db = DBConnection()
    
    try:
        # Get current instance concurrency from semaphore
        semaphore_available = _run_semaphore._value
        current_instance_runs = MAX_CONCURRENT_RUNS - semaphore_available
        
        # Count active agent runs from database (source of truth across all instances)
        client = await db.client
        active_runs_result = await client.table('agent_runs')\
            .select('id', count='exact')\
            .eq('status', 'running')\
            .execute()
        active_agent_runs = active_runs_result.count or 0
        
        # Count active Redis stream keys (real-time tracking)
        active_redis_streams = 0
        try:
            redis_client = await redis.get_client()
            # Use SCAN to find all agent_run:*:stream keys (non-blocking)
            cursor = 0
            pattern = "agent_run:*:stream"
            while True:
                cursor, keys = await redis_client.scan(cursor, match=pattern, count=100)
                active_redis_streams += len(keys)
                if cursor == 0:
                    break
        except Exception as e:
            logger.warning(f"Failed to count Redis stream keys: {e}")
            # Fallback: use DB count if Redis fails
            active_redis_streams = active_agent_runs
        
        utilization_percent = (current_instance_runs / MAX_CONCURRENT_RUNS * 100) if MAX_CONCURRENT_RUNS > 0 else 0
        
        # Orphaned streams = Redis streams without corresponding 'running' DB record
        # Should be 0 in healthy state - non-zero indicates cleanup issues
        orphaned_streams = max(0, active_redis_streams - active_agent_runs)
        
        return {
            # Real metrics - useful data
            "active_agent_runs": active_agent_runs,  # Total across all instances (DB)
            "active_redis_streams": active_redis_streams,  # Real-time Redis streams
            "orphaned_streams": orphaned_streams,  # Streams without DB records (should be 0)
            "current_instance_runs": current_instance_runs,  # This instance only
            "max_concurrent_runs": MAX_CONCURRENT_RUNS,
            "available_slots": semaphore_available,
            "utilization_percent": round(utilization_percent, 2),
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
    except Exception as e:
        logger.error(f"Failed to get API instance metrics: {e}")
        raise


async def get_worker_count() -> int:
    """
    Get active agent run count (simplified version).
    
    Returns:
        Number of active agent runs across all instances
    """
    try:
        metrics = await get_worker_metrics()
        return metrics["active_agent_runs"]
    except Exception as e:
        logger.error(f"Failed to get active agent run count: {e}")
        return 0


async def publish_to_cloudwatch(metrics: dict) -> bool:
    """
    Publish API instance metrics to CloudWatch for monitoring.
    
    Args:
        metrics: API instance metrics dict from get_worker_metrics()
        
    Returns:
        True if published successfully, False otherwise
    """
    cloudwatch = _get_cloudwatch_client()
    if cloudwatch is None:
        return False
    
    try:
        metric_data = [
            {
                'MetricName': 'ActiveAgentRuns',
                'Value': metrics.get('active_agent_runs', 0),
                'Unit': 'Count',
                'Dimensions': [{'Name': 'Service', 'Value': 'api'}]
            },
            {
                'MetricName': 'CurrentInstanceRuns',
                'Value': metrics.get('current_instance_runs', 0),
                'Unit': 'Count',
                'Dimensions': [{'Name': 'Service', 'Value': 'api'}]
            },
            {
                'MetricName': 'MaxConcurrentRuns',
                'Value': metrics.get('max_concurrent_runs', 0),
                'Unit': 'Count',
                'Dimensions': [{'Name': 'Service', 'Value': 'api'}]
            },
            {
                'MetricName': 'AgentRunUtilization',
                'Value': metrics.get('utilization_percent', 0),
                'Unit': 'Percent',
                'Dimensions': [{'Name': 'Service', 'Value': 'api'}]
            },
            {
                'MetricName': 'OrphanedStreams',
                'Value': metrics.get('orphaned_streams', 0),
                'Unit': 'Count',
                'Dimensions': [{'Name': 'Service', 'Value': 'api'}]
            }
        ]
        
        cloudwatch.put_metric_data(
            Namespace='Kortix',
            MetricData=metric_data
        )
        logger.debug(f"Published API instance metrics to CloudWatch: {metrics.get('active_agent_runs')} total runs, {metrics.get('current_instance_runs')}/{metrics.get('max_concurrent_runs')} on this instance ({metrics.get('utilization_percent')}%)")
        return True
    except Exception as e:
        logger.error(f"Failed to publish API instance metrics to CloudWatch: {e}")
        return False


async def start_cloudwatch_publisher(interval_seconds: int = 60):
    """
    Background task to publish API instance metrics to CloudWatch periodically.
    
    Args:
        interval_seconds: How often to publish (default 60s)
    """
    logger.info(f"Starting CloudWatch API instance metrics publisher (interval: {interval_seconds}s)")
    
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            
            metrics = await get_worker_metrics()
            await publish_to_cloudwatch(metrics)
            
        except asyncio.CancelledError:
            logger.info("CloudWatch API instance metrics publisher stopped")
            raise
        except Exception as e:
            logger.error(f"Error in CloudWatch API instance publisher loop: {e}")
