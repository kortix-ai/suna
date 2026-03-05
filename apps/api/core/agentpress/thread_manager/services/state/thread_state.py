import asyncio
import time
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
