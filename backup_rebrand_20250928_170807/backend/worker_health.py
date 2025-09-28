import dotenv
dotenv.load_dotenv()

from core.utils.logger import logger
import run_agent_background
from core.services import redis
import asyncio
from core.utils.retry import retry
import uuid


async def main():
    await retry(lambda: redis.initialize_async())
    key = uuid.uuid4().hex
    run_agent_background.check_health.send(key)
    timeout = 20  # seconds
    elapsed = 0
    while elapsed < timeout:
        if await redis.get(key) == "healthy":
            break
        await asyncio.sleep(1)
        elapsed += 1

    if elapsed >= timeout:
        logger.critical("Health check timed out")
        exit(1)
    else:
        logger.critical("Health check passed")
        await redis.delete(key)
        await redis.close()
        exit(0)


if __name__ == "__main__":
    asyncio.run(main())
