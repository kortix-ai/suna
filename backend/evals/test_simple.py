"""
Simple test to debug eval system.
"""

import asyncio
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from evals.runner import AgentEvalRunner, EvalCase
from core.utils.logger import logger


async def main():
    logger.info("Starting simple eval test...")
    
    runner = AgentEvalRunner(
        project_name="Test",
        model_name="kortix/basic",  # Use default model
        max_iterations=5,
        timeout_seconds=30.0,
    )
    
    case = EvalCase(
        input="What is 2 + 2?",
        expected="4",
        tags=["test"],
    )
    
    logger.info("Running test case...")
    result = await runner.run_case(case)
    
    logger.info(f"Result: {result.output}")
    logger.info(f"Error: {result.error}")
    logger.info(f"Tools: {result.tools_called}")
    logger.info(f"Duration: {result.duration_ms}ms")


if __name__ == "__main__":
    asyncio.run(main())

