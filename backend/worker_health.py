"""
Worker health check script for Temporal workers.

This performs connectivity checks for Redis and Temporal Cloud.
"""
import dotenv
dotenv.load_dotenv()

from core.utils.logger import logger
from core.services import redis
from core.temporal.client import get_temporal_client
import asyncio
from core.utils.retry import retry


async def main():
    """
    Health check that verifies:
    1. Redis connection is working
    2. Temporal Cloud connection is working
    """
    try:
        # Initialize Redis connection
        await retry(lambda: redis.initialize_async())
        
        # Simple ping to verify Redis connection
        client = await redis.get_client()
        pong = await client.ping()
        
        if not pong:
            logger.critical("Health check failed: Redis ping returned False")
            exit(1)
        
        # Verify Temporal Cloud connection
        try:
            temporal_client = await get_temporal_client()
            # Connection successful if no exception raised
            logger.info("Health check passed: Redis and Temporal Cloud connectivity OK")
        except Exception as temporal_err:
            logger.critical(f"Health check failed: Temporal Cloud connection error: {temporal_err}")
            exit(1)
        
        await redis.close()
        exit(0)
        
    except Exception as e:
        logger.critical(f"Health check failed: {e}")
        exit(1)


if __name__ == "__main__":
    asyncio.run(main())
