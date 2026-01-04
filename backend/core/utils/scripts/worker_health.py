"""
Worker health check script.

This performs a simple Redis connectivity check to ensure the worker can connect
to Redis and perform basic operations. This ensures health checks pass even when
the worker is under load processing Redis Streams messages.

The health check is independent of Redis Streams load and verifies:
1. Redis connection is working
2. Can read/write to Redis
"""
import dotenv
dotenv.load_dotenv()

from core.utils.logger import logger
from core.services import redis
import asyncio
from core.utils.retry import retry


async def main():
    """
    Health check that verifies:
    1. Redis connection is working
    2. Can read/write to Redis
    
    This is independent of Redis Streams load.
    """
    try:
        # Initialize Redis connection
        await retry(lambda: redis.initialize_async())
        
        # Simple ping to verify connection
        client = await redis.get_client()
        pong = await client.ping()
        
        if not pong:
            logger.critical("Health check failed: Redis ping returned False")
            exit(1)
        
        # Optional: verify we can write/read (tests full connectivity)
        test_key = "worker_health_check"
        await client.set(test_key, "ok", ex=10)
        value = await client.get(test_key)
        
        if value != "ok":
            logger.critical(f"Health check failed: Redis read/write test failed (got {value})")
            exit(1)
        
        logger.info("Health check passed: Redis connectivity OK")
        await redis.close()
        exit(0)
        
    except Exception as e:
        logger.critical(f"Health check failed: {e}")
        exit(1)


if __name__ == "__main__":
    asyncio.run(main())
