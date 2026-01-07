"""
Stream info for metrics - agent runs execute directly, only memory/categorization use streams.
"""

from typing import Dict, Any
from core.utils.logger import logger
from .tasks import StreamName

CONSUMER_GROUP = "suna-workers"


async def get_stream_info() -> Dict[str, Any]:
    """Get stream information for memory/categorization streams."""
    from core.services import redis
    
    result = {
        "consumer_group": CONSUMER_GROUP,
        "streams": {},
    }
    
    redis_client = await redis.get_client()
    
    for stream in StreamName:
        try:
            info = await redis_client.xinfo_stream(stream.value)
            
            pending_count = 0
            lag = 0
            consumers = []
            
            try:
                groups = await redis_client.xinfo_groups(stream.value)
                for group in groups:
                    if group.get("name") == CONSUMER_GROUP:
                        pending_count = group.get("pending", 0)
                        lag = group.get("lag", 0) or 0
                        try:
                            consumer_info = await redis_client.xinfo_consumers(stream.value, CONSUMER_GROUP)
                            consumers = [
                                {
                                    "name": c.get("name"),
                                    "pending": c.get("pending"),
                                    "idle_ms": c.get("idle"),
                                }
                                for c in consumer_info
                            ]
                        except:
                            pass
            except:
                pass
            
            result["streams"][stream.value] = {
                "length": info.get("length", 0),
                "pending_count": pending_count,
                "lag": lag,
                "consumers": consumers,
            }
        except Exception as e:
            result["streams"][stream.value] = {"error": str(e)}
    
    return result

