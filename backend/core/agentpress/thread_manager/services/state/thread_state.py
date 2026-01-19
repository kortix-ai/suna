import asyncio
import json
import time
from typing import Optional, Dict, Any
from core.utils.logger import logger


class ThreadState:
    @staticmethod
    async def set_has_images(thread_id: str, client=None) -> bool:
        from core.services import redis
        from core.threads import repo as threads_repo
        
        cache_key = f"thread_has_images:{thread_id}"
        
        try:
            cached = await redis.get(cache_key)
            if cached == "1":
                return True
            
            metadata = await threads_repo.get_thread_metadata(thread_id)
            if metadata is None:
                logger.warning(f"Thread {thread_id} not found when setting has_images flag")
                return False
            
            if not (metadata or {}).get('has_images'):
                await threads_repo.set_thread_has_images(thread_id)
            
            await redis.set(cache_key, "1", ex=7200)
            
            logger.info(f"🖼️ Set has_images=True for thread {thread_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to set has_images flag for thread {thread_id}: {e}")
            return False
    
    @staticmethod
    async def check_has_images(thread_id: str) -> bool:
        from core.services import redis
        from core.threads import repo as threads_repo
        
        start = time.time()
        cache_key = f"thread_has_images:{thread_id}"
        
        try:
            try:
                cached = await asyncio.wait_for(redis.get(cache_key), timeout=0.5)
                if cached == "1":
                    elapsed = (time.time() - start) * 1000
                    logger.info(f"🖼️ Thread {thread_id} has_images: True (from Redis, {elapsed:.1f}ms)")
                    return True
                elif cached == "0":
                    elapsed = (time.time() - start) * 1000
                    logger.debug(f"🖼️ Thread {thread_id} has_images: False (from Redis, {elapsed:.1f}ms)")
                    return False
            except Exception:
                pass
            
            try:
                has_images = await asyncio.wait_for(
                    threads_repo.check_thread_has_images(thread_id),
                    timeout=5.0
                )
            except asyncio.TimeoutError:
                elapsed = (time.time() - start) * 1000
                logger.warning(f"⚠️ thread_has_images QUERY timeout after {elapsed:.1f}ms for {thread_id}")
                return False
            
            try:
                if has_images:
                    await redis.set(cache_key, "1", ex=7200)
                else:
                    await redis.set(cache_key, "0", ex=300)
            except Exception:
                pass
            
            elapsed = (time.time() - start) * 1000
            logger.debug(f"🖼️ Thread {thread_id} has_images: {has_images} (from DB, {elapsed:.1f}ms)")
            return has_images
        except Exception as e:
            elapsed = (time.time() - start) * 1000
            logger.error(f"Error checking thread for images after {elapsed:.1f}ms: {str(e)}")
            return False

    @staticmethod
    async def set_last_usage(thread_id: str, usage: Dict[str, Any], model: str = None) -> bool:
        """Cache the last LLM usage data for a thread in Redis.

        Args:
            thread_id: The thread ID
            usage: Usage dict with total_tokens, prompt_tokens, completion_tokens, etc.
            model: Optional model name

        Returns:
            True if cached successfully
        """
        from core.services import redis

        cache_key = f"thread_usage:{thread_id}"

        try:
            cache_data = {
                "total_tokens": usage.get("total_tokens", 0),
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
                "model": model or "",
                "cached_at": time.time()
            }

            await redis.set(cache_key, json.dumps(cache_data), ex=7200)

            logger.debug(f"⚡ Cached usage for thread {thread_id}: {cache_data['total_tokens']} tokens")
            return True
        except Exception as e:
            logger.warning(f"Failed to cache usage for thread {thread_id}: {e}")
            return False

    @staticmethod
    async def get_last_usage(thread_id: str) -> Optional[Dict[str, Any]]:
        """Get cached LLM usage data for a thread from Redis.

        Args:
            thread_id: The thread ID

        Returns:
            Usage dict if found in cache, None otherwise
        """
        from core.services import redis

        start = time.time()
        cache_key = f"thread_usage:{thread_id}"

        try:
            cached = await asyncio.wait_for(redis.get(cache_key), timeout=0.5)
            if cached:
                usage_data = json.loads(cached)
                elapsed = (time.time() - start) * 1000
                logger.debug(f"⚡ Got cached usage for thread {thread_id}: {usage_data.get('total_tokens')} tokens ({elapsed:.1f}ms)")
                return usage_data

            elapsed = (time.time() - start) * 1000
            logger.debug(f"⚡ No cached usage for thread {thread_id} ({elapsed:.1f}ms)")
            return None
        except asyncio.TimeoutError:
            logger.warning(f"⚠️ Redis timeout getting cached usage for thread {thread_id}")
            return None
        except Exception as e:
            logger.warning(f"Failed to get cached usage for thread {thread_id}: {e}")
            return None

    @staticmethod
    async def clear_usage_cache(thread_id: str) -> bool:
        """Clear cached usage data for a thread (e.g., after compression).

        Args:
            thread_id: The thread ID

        Returns:
            True if cleared successfully
        """
        from core.services import redis

        cache_key = f"thread_usage:{thread_id}"

        try:
            await redis.delete(cache_key)
            logger.debug(f"🗑️ Cleared usage cache for thread {thread_id}")
            return True
        except Exception as e:
            logger.warning(f"Failed to clear usage cache for thread {thread_id}: {e}")
            return False
