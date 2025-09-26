import json
from typing import Any
from core.services.redis import get_client


class _cache:
    async def get(self, key: str):
        redis = await get_client()
        key = f"cache:{key}"
        result = await redis.get(key)
        if result:
            return json.loads(result)
        return None

    async def set(self, key: str, value: Any, ttl: int = 15 * 60):
        redis = await get_client()
        key = f"cache:{key}"
        await redis.set(key, json.dumps(value), ex=ttl)

    async def invalidate(self, key: str):
        redis = await get_client()
        key = f"cache:{key}"
        await redis.delete(key)


Cache = _cache()
