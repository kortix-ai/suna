"""
Worker health check script.

This performs a simple Redis connectivity check rather than sending a task through
the Dramatiq queue. This ensures health checks pass even when the queue is under load.

The old approach (sending a Dramatiq task) could fail under load because:
1. All worker threads busy processing agent runs
2. Health check task waits in queue behind other tasks
3. Times out after 20s → ECS kills the worker
4. Creates a vicious cycle where workers can't start
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
    
    This is independent of Dramatiq queue load.
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
