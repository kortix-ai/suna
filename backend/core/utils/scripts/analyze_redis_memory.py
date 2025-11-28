#!/usr/bin/env python3
"""
Analyze Redis memory usage - find what's consuming the most space.
"""

import asyncio
import os
import sys
from collections import defaultdict
from dotenv import load_dotenv

# Add backend directory to path
backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, backend_dir)

load_dotenv()

from core.services import redis as redis_service
from core.utils.logger import logger


async def get_key_size(redis_client, key: str) -> int:
    """Get memory usage of a key in bytes."""
    try:
        # Use MEMORY USAGE command (Redis 4.0+)
        size = await redis_client.execute_command("MEMORY", "USAGE", key)
        return int(size) if size else 0
    except Exception:
        # Fallback: estimate based on type
        key_type = await redis_client.type(key)
        if key_type == b"string" or key_type == "string":
            val = await redis_client.get(key)
            return len(val) if val else 0
        elif key_type == b"list" or key_type == "list":
            length = await redis_client.llen(key)
            # Rough estimate: 100 bytes per item
            return length * 100
        elif key_type == b"hash" or key_type == "hash":
            length = await redis_client.hlen(key)
            return length * 200
        elif key_type == b"set" or key_type == "set":
            length = await redis_client.scard(key)
            return length * 100
        elif key_type == b"zset" or key_type == "zset":
            length = await redis_client.zcard(key)
            return length * 150
        return 0


async def analyze_redis():
    """Analyze Redis memory usage."""
    logger.info("🔍 Analyzing Redis memory usage...")
    
    try:
        await redis_service.initialize_async()
        redis_client = await redis_service.get_client()
        
        # Get total memory info
        info = await redis_client.info("memory")
        used_memory = info.get("used_memory", 0)
        used_memory_mb = used_memory / (1024 * 1024)
        max_memory = info.get("maxmemory", 0)
        max_memory_mb = max_memory / (1024 * 1024) if max_memory > 0 else 0
        
        logger.info(f"📊 Total Redis Memory: {used_memory_mb:.2f} MB / {max_memory_mb:.2f} MB ({used_memory_mb/max_memory_mb*100:.1f}%)" if max_memory_mb > 0 else f"📊 Total Redis Memory: {used_memory_mb:.2f} MB")
        
        # Get all keys
        logger.info("🔍 Scanning all keys...")
        all_keys = []
        cursor = 0
        while True:
            cursor, batch = await redis_client.scan(cursor, count=1000)
            all_keys.extend([k.decode() if isinstance(k, bytes) else k for k in batch])
            if cursor == 0:
                break
        
        total_keys = len(all_keys)
        logger.info(f"📋 Found {total_keys} total keys")
        
        # Group by pattern
        pattern_stats = defaultdict(lambda: {"count": 0, "size": 0, "keys": []})
        
        # Analyze top keys by size
        logger.info("🔍 Analyzing key sizes (this may take a minute)...")
        key_sizes = []
        
        for i, key in enumerate(all_keys):
            if i % 100 == 0:
                logger.info(f"   Processing {i}/{total_keys} keys...")
            
            try:
                size = await get_key_size(redis_client, key)
                key_sizes.append((key, size))
                
                # Categorize by pattern
                if key.startswith("agent_run:"):
                    if ":responses" in key:
                        pattern_stats["agent_run:*:responses"]["count"] += 1
                        pattern_stats["agent_run:*:responses"]["size"] += size
                        pattern_stats["agent_run:*:responses"]["keys"].append(key)
                    else:
                        pattern_stats["agent_run:*"]["count"] += 1
                        pattern_stats["agent_run:*"]["size"] += size
                elif key.startswith("agent_config:"):
                    pattern_stats["agent_config:*"]["count"] += 1
                    pattern_stats["agent_config:*"]["size"] += size
                elif key.startswith("agent_mcps:"):
                    pattern_stats["agent_mcps:*"]["count"] += 1
                    pattern_stats["agent_mcps:*"]["size"] += size
                elif key.startswith("project:"):
                    pattern_stats["project:*"]["count"] += 1
                    pattern_stats["project:*"]["size"] += size
                elif key.startswith("dramatiq:"):
                    pattern_stats["dramatiq:*"]["count"] += 1
                    pattern_stats["dramatiq:*"]["size"] += size
                elif key.startswith("active_run:"):
                    pattern_stats["active_run:*"]["count"] += 1
                    pattern_stats["active_run:*"]["size"] += size
                elif key.startswith("thread_count:"):
                    pattern_stats["thread_count:*"]["count"] += 1
                    pattern_stats["thread_count:*"]["size"] += size
                elif key.startswith("api_key:"):
                    pattern_stats["api_key:*"]["count"] += 1
                    pattern_stats["api_key:*"]["size"] += size
                elif key.startswith("account_state:"):
                    pattern_stats["account_state:*"]["count"] += 1
                    pattern_stats["account_state:*"]["size"] += size
                else:
                    pattern_stats["other"]["count"] += 1
                    pattern_stats["other"]["size"] += size
            except Exception as e:
                logger.debug(f"Error analyzing key {key}: {e}")
        
        # Sort patterns by size
        sorted_patterns = sorted(pattern_stats.items(), key=lambda x: x[1]["size"], reverse=True)
        
        logger.info("\n" + "="*80)
        logger.info("📊 MEMORY USAGE BY PATTERN:")
        logger.info("="*80)
        
        total_analyzed = 0
        for pattern, stats in sorted_patterns:
            size_mb = stats["size"] / (1024 * 1024)
            percentage = (stats["size"] / used_memory * 100) if used_memory > 0 else 0
            logger.info(f"\n{pattern}:")
            logger.info(f"  Count: {stats['count']:,} keys")
            logger.info(f"  Size: {size_mb:.2f} MB ({percentage:.1f}% of total)")
            total_analyzed += stats["size"]
        
        logger.info("\n" + "="*80)
        logger.info("🔝 TOP 20 LARGEST KEYS:")
        logger.info("="*80)
        
        # Sort by size and show top 20
        key_sizes.sort(key=lambda x: x[1], reverse=True)
        for i, (key, size) in enumerate(key_sizes[:20], 1):
            size_mb = size / (1024 * 1024)
            logger.info(f"{i:2d}. {key[:60]:<60} {size_mb:>8.2f} MB")
        
        logger.info("\n" + "="*80)
        logger.info("✅ Analysis complete!")
        logger.info("="*80)
        
    except Exception as e:
        logger.error(f"❌ Error during analysis: {e}", exc_info=True)
        raise
    finally:
        try:
            await redis_service.close()
        except Exception:
            pass


if __name__ == "__main__":
    asyncio.run(analyze_redis())

