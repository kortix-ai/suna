#!/usr/bin/env python3
"""
Redis Streams worker entry point.

Usage:
    uv run python run_worker.py --concurrency 48
"""

import dotenv
dotenv.load_dotenv(".env")

import asyncio
import argparse
import signal
import os

from core.utils.logger import logger
from core.utils.tool_discovery import warm_up_tools_cache
from core.worker import StreamWorker
from core.worker.handlers import get_handlers


async def main(concurrency: int = 48):
    """Main entry point."""
    logger.info("=" * 60)
    logger.info("🚀 Starting Redis Streams Worker")
    logger.info("=" * 60)
    
    worker = None
    try:
        warm_up_tools_cache()
        
        handlers = get_handlers()
        logger.info(f"Loaded {len(handlers)} handlers")
        
        worker = StreamWorker(handlers=handlers, concurrency=concurrency)
        
        loop = asyncio.get_event_loop()
        
        def signal_handler():
            logger.info("Shutdown signal received")
            asyncio.create_task(worker.stop())
        
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, signal_handler)
            except NotImplementedError:
                signal.signal(sig, lambda s, f: signal_handler())
        
        await worker.start()
    except KeyboardInterrupt:
        logger.info("Keyboard interrupt received")
    except Exception as e:
        logger.error(f"Fatal error in worker: {e}", exc_info=True)
        raise
    finally:
        if worker:
            await worker.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Redis Streams Worker")
    parser.add_argument(
        "--concurrency", "-c",
        type=int,
        default=int(os.getenv("STREAM_WORKER_CONCURRENCY", "48"))
    )
    args = parser.parse_args()
    
    asyncio.run(main(concurrency=args.concurrency))
