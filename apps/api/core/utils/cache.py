import json
from datetime import datetime, date
from typing import Any
from core.services.redis import get_client


class DateTimeEncoder(json.JSONEncoder):
    """Custom JSON encoder that handles datetime objects."""
    def default(self, obj):
        if isinstance(obj, datetime):
            return obj.isoformat()
        if isinstance(obj, date):
            return obj.isoformat()
        return super().default(obj)


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
        await redis.set(key, json.dumps(value, cls=DateTimeEncoder), ex=ttl)

    async def invalidate(self, key: str):
        redis = await get_client()
        key = f"cache:{key}"
        await redis.delete(key)
    
    async def invalidate_multiple(self, keys: list[str]):
        """Invalidate multiple cache keys using batch delete."""
        from core.services.redis import delete_multiple
        prefixed_keys = [f"cache:{key}" for key in keys]
        await delete_multiple(prefixed_keys, timeout=5.0)


Cache = _cache()
