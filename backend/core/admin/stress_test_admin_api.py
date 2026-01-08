"""
Admin Stress Test API
Allows admins to run stress tests on the platform with bypassed limits.
Measures detailed timing including TTFT (Time to First Token).

TIMING DEFINITIONS:
- thread_creation_time: Time from start until agent_run_id is created and background task starts.
  This includes: load_agent_config, create_project, create_thread, create_message, create_agent_run.
  
- time_to_first_response: Time from when the background agent execution starts until first LLM response.
  This includes: agent setup, MCP initialization, prompt building, message fetch, LLM call, and TTFT.
  This is the "⏱️ FIRST RESPONSE" value from agent_runner.py logs.
  
- total_ttft: thread_creation_time + time_to_first_response
  This is the total time from user request until they see the first response.
"""

from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from typing import Optional, List, Dict, Any
from datetime import datetime, timezone
from pydantic import BaseModel
import asyncio
import uuid
import json
import random
import time
from core.auth import require_super_admin
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.services.redis import redis

router = APIRouter(prefix="/admin/stress-test", tags=["admin-stress-test"])

# ============================================================================
# MODELS
# ============================================================================

class StressTestConfig(BaseModel):
    num_requests: int = 20
    batch_size: int = 20
    prompts: Optional[List[str]] = None
    measure_ttft: bool = True  # Whether to wait for first response
    ttft_timeout: float = 120.0  # Max seconds to wait for first response

class StressTestResult(BaseModel):
    request_id: int
    status: str  # pending, running, done, error
    thread_id: Optional[str] = None
    project_id: Optional[str] = None
    agent_run_id: Optional[str] = None
    # Timing breakdown
    thread_creation_time: float = 0.0  # Time to create thread (before background task)
    time_to_first_response: Optional[float] = None  # Time from agent start to first response (from Redis)
    total_ttft: Optional[float] = None  # thread_creation_time + time_to_first_response
    llm_ttft: Optional[float] = None  # Actual LLM TTFT (pure litellm call time, from llm.py)
    # Detailed timings (in ms)
    timing_breakdown: Optional[Dict[str, float]] = None
    error: Optional[str] = None

# Default prompts for stress testing
DEFAULT_PROMPTS = [
    "What is 2 + 2?",
    "Say hello",
    "Tell me a joke",
    "Count to 5",
    "What's your name?",
]


class TimingResult:
    """Container for timing values from Redis stream."""
    def __init__(self):
        self.first_response_ms: Optional[float] = None  # Time to first response (agent setup overhead)
        self.llm_ttft_seconds: Optional[float] = None   # Actual LLM TTFT (from llm.py)


async def wait_for_timing_messages(agent_run_id: str, timeout: float = 120.0) -> TimingResult:
    """
    Subscribe to Redis stream and wait for timing messages.
    
    Captures two metrics:
    - first_response_ms: From 'timing' message - time from agent execution start to first response
    - llm_ttft_seconds: From 'llm_ttft' message - actual LLM time to first token (pure LLM latency)
    
    Returns TimingResult with both values.
    """
    stream_key = f"agent_run:{agent_run_id}:stream"
    start_time = time.time()
    last_id = "0"
    
    result = TimingResult()
    logger.info(f"[STRESS TEST] Waiting for timing messages on stream: {stream_key}")
    
    while time.time() - start_time < timeout:
        # Stop if we have both values
        if result.first_response_ms is not None and result.llm_ttft_seconds is not None:
            break
            
        try:
            # Read from stream with 200ms block
            entries = await redis.xread({stream_key: last_id}, count=10, block=200)
            
            if entries:
                for stream_name, stream_entries in entries:
                    for entry_id, fields in stream_entries:
                        last_id = entry_id
                        try:
                            # Handle both bytes and string keys
                            data_field = fields.get(b'data') or fields.get('data')
                            if isinstance(data_field, bytes):
                                data_field = data_field.decode()
                            
                            data = json.loads(data_field or '{}')
                            msg_type = data.get('type')
                            
                            # Look for the timing message we emit from agent_runner
                            if msg_type == 'timing' and 'first_response_ms' in data:
                                result.first_response_ms = data['first_response_ms']
                            
                            # Look for the LLM TTFT message from response_processor
                            if msg_type == 'llm_ttft' and 'ttft_seconds' in data:
                                result.llm_ttft_seconds = data['ttft_seconds']
                            
                            # If we get a terminal status, stop waiting
                            if msg_type == 'status' and data.get('status') in ['completed', 'failed', 'stopped', 'error']:
                                logger.info(f"[STRESS TEST] Got terminal status '{data.get('status')}' - stopping wait. Result: first_response_ms={result.first_response_ms}, llm_ttft={result.llm_ttft_seconds}")
                                return result
                        except Exception as e:
                            logger.debug(f"Error parsing stream message: {e}")
        except Exception as e:
            # Stream might not exist yet, keep waiting
            logger.debug(f"[STRESS TEST] Redis xread error (stream may not exist yet): {e}")
            await asyncio.sleep(0.2)
    
    logger.warning(f"[STRESS TEST] Timeout waiting for timing messages after {timeout}s. Result: first_response_ms={result.first_response_ms}, llm_ttft={result.llm_ttft_seconds}")
    return result


async def run_single_agent_with_timing(
    request_id: int,
    account_id: str,
    prompt: str,
    measure_ttft: bool = True,
    ttft_timeout: float = 120.0,
) -> Dict[str, Any]:
    """Run a single agent request with detailed timing breakdown."""
    from core.agents.config import load_agent_config
    from core.threads import repo as threads_repo
    from core.agents.api import (
        _get_effective_model, 
        _create_agent_run_record,
        execute_agent_run,
        _cancellation_events
    )
    from core.services.supabase import DBConnection
    
    total_start = time.time()
    timings = {}
    
    result = {
        "request_id": request_id,
        "status": "error",
        "thread_id": None,
        "project_id": None,
        "agent_run_id": None,
        "thread_creation_time": 0.0,
        "time_to_first_response": None,
        "total_ttft": None,
        "llm_ttft": None,  # Actual LLM TTFT from llm.py
        "timing_breakdown": {},
        "error": None,
    }
    
    try:
        db = DBConnection()
        client = await db.client
        
        # Step 1: Load agent config
        t1 = time.time()
        agent_config = await load_agent_config(None, account_id, user_id=account_id, client=client, is_new_thread=True)
        timings["load_config"] = round((time.time() - t1) * 1000, 1)
        logger.info(f"[STRESS TEST #{request_id}] Step 1 load_config: {timings['load_config']:.1f}ms")
        
        # Step 2: Get effective model
        t2 = time.time()
        effective_model = await _get_effective_model(None, agent_config, client, account_id)
        timings["get_model"] = round((time.time() - t2) * 1000, 1)
        logger.info(f"[STRESS TEST #{request_id}] Step 2 get_model: {timings['get_model']:.1f}ms")
        
        # Step 3: Create project
        t3 = time.time()
        project_id = str(uuid.uuid4())
        placeholder_name = f"{prompt[:30]}..." if len(prompt) > 30 else prompt
        await threads_repo.create_project(project_id=project_id, account_id=account_id, name=placeholder_name)
        timings["create_project"] = round((time.time() - t3) * 1000, 1)
        logger.info(f"[STRESS TEST #{request_id}] Step 3 create_project: {timings['create_project']:.1f}ms")
        
        # Step 4: Create thread
        t4 = time.time()
        thread_id = str(uuid.uuid4())
        await threads_repo.create_thread_full(
            thread_id=thread_id,
            project_id=project_id,
            account_id=account_id,
            name="Stress Test",
            status="pending"
        )
        timings["create_thread"] = round((time.time() - t4) * 1000, 1)
        logger.info(f"[STRESS TEST #{request_id}] Step 4 create_thread: {timings['create_thread']:.1f}ms")
        
        # Step 5: Create user message
        t5 = time.time()
        await threads_repo.create_message_full(
            message_id=str(uuid.uuid4()),
            thread_id=thread_id,
            message_type="user",
            content={"role": "user", "content": prompt},
            is_llm_message=True
        )
        timings["create_message"] = round((time.time() - t5) * 1000, 1)
        logger.info(f"[STRESS TEST #{request_id}] Step 5 create_message: {timings['create_message']:.1f}ms")
        
        # Step 6: Create agent run record
        t6 = time.time()
        now_iso = datetime.now(timezone.utc).isoformat()
        await threads_repo.update_thread_status(thread_id=thread_id, status="ready", 
                                                 initialization_started_at=now_iso,
                                                 initialization_completed_at=now_iso)
        agent_run_id = await _create_agent_run_record(thread_id, agent_config, effective_model, account_id)
        timings["create_agent_run"] = round((time.time() - t6) * 1000, 1)
        logger.info(f"[STRESS TEST #{request_id}] Step 6 create_agent_run: {timings['create_agent_run']:.1f}ms")
        
        thread_creation_time = time.time() - total_start
        
        # Step 7: Start agent execution in background
        t7 = time.time()
        cancellation_event = asyncio.Event()
        _cancellation_events[agent_run_id] = cancellation_event
        
        async def execute_run():
            try:
                await execute_agent_run(
                    agent_run_id=agent_run_id,
                    thread_id=thread_id,
                    project_id=project_id,
                    model_name=effective_model,
                    agent_config=agent_config,
                    account_id=account_id,
                    cancellation_event=cancellation_event
                )
            finally:
                _cancellation_events.pop(agent_run_id, None)
        
        asyncio.create_task(execute_run())
        timings["start_background_task"] = round((time.time() - t7) * 1000, 1)
        
        result["status"] = "done"
        result["thread_id"] = thread_id
        result["project_id"] = project_id
        result["agent_run_id"] = agent_run_id
        result["thread_creation_time"] = round(thread_creation_time, 3)
        result["timing_breakdown"] = timings
        
        # Step 8: Wait for timing messages from agent_runner and response_processor (if requested)
        if measure_ttft:
            timing_result = await wait_for_timing_messages(agent_run_id, timeout=ttft_timeout)
            
            if timing_result.first_response_ms is not None:
                result["time_to_first_response"] = round(timing_result.first_response_ms / 1000, 3)
                result["total_ttft"] = round(thread_creation_time + (timing_result.first_response_ms / 1000), 3)
            
            if timing_result.llm_ttft_seconds is not None:
                result["llm_ttft"] = round(timing_result.llm_ttft_seconds, 3)
        
    except Exception as e:
        elapsed = time.time() - total_start
        error_msg = str(e)[:200]
        logger.error(f"Stress test request {request_id} failed: {error_msg}")
        
        result["thread_creation_time"] = round(elapsed, 3)
        result["timing_breakdown"] = timings
        result["error"] = error_msg
    
    return result


@router.post("/run")
async def run_stress_test(
    config: StressTestConfig,
    admin: dict = Depends(require_super_admin)
):
    """
    Run a stress test with the specified configuration.
    Returns results as a streaming JSON response for live updates.
    
    Timing Metrics:
    - thread_creation_time: Time to set up thread/project/message before agent starts
    - time_to_first_response: Time from agent start until first LLM response chunk
    - total_ttft: Sum of above (total time from request to first response)
    """
    account_id = admin.get("user_id")
    
    if not account_id:
        raise HTTPException(status_code=400, detail="Could not determine admin account ID")
    
    prompts = config.prompts or DEFAULT_PROMPTS
    num_requests = min(config.num_requests, 200)
    batch_size = min(config.batch_size, 50)
    measure_ttft = config.measure_ttft
    ttft_timeout = config.ttft_timeout
    
    logger.info(f"Admin {account_id} starting stress test: {num_requests} requests, batch size {batch_size}, measure_ttft={measure_ttft}")
    
    async def generate():
        """Generator for streaming results."""
        all_results: List[Dict[str, Any]] = []
        start_time = time.time()
        num_batches = (num_requests + batch_size - 1) // batch_size
        
        # Send initial config
        yield json.dumps({
            "type": "config",
            "num_requests": num_requests,
            "batch_size": batch_size,
            "num_batches": num_batches,
            "measure_ttft": measure_ttft,
        }) + "\n"
        
        for batch_num in range(num_batches):
            batch_start = batch_num * batch_size
            batch_end = min(batch_start + batch_size, num_requests)
            batch_ids = range(batch_start, batch_end)
            
            # Send batch start event
            yield json.dumps({
                "type": "batch_start",
                "batch_num": batch_num + 1,
                "batch_start": batch_start,
                "batch_end": batch_end,
            }) + "\n"
            
            # Mark all as running
            for req_id in batch_ids:
                yield json.dumps({
                    "type": "status",
                    "request_id": req_id,
                    "status": "running",
                }) + "\n"
            
            # Run batch concurrently
            tasks = [
                run_single_agent_with_timing(
                    request_id=req_id,
                    account_id=account_id,
                    prompt=random.choice(prompts),
                    measure_ttft=measure_ttft,
                    ttft_timeout=ttft_timeout,
                )
                for req_id in batch_ids
            ]
            
            batch_results = await asyncio.gather(*tasks)
            all_results.extend(batch_results)
            
            # Send individual results
            for result in batch_results:
                yield json.dumps({
                    "type": "result",
                    **result,
                }) + "\n"
            
            # Small delay between batches
            if batch_num < num_batches - 1:
                await asyncio.sleep(0.5)
        
        # Calculate summary
        total_time = time.time() - start_time
        successful = [r for r in all_results if r["status"] == "done"]
        failed = [r for r in all_results if r["status"] == "error"]
        
        thread_times = [r["thread_creation_time"] for r in all_results if r["thread_creation_time"] > 0]
        first_response_times = [r["time_to_first_response"] for r in all_results if r.get("time_to_first_response") is not None]
        total_ttft_times = [r["total_ttft"] for r in all_results if r.get("total_ttft") is not None]
        llm_ttft_times = [r["llm_ttft"] for r in all_results if r.get("llm_ttft") is not None]
        
        # Aggregate timing breakdown
        timing_aggregates = {}
        for r in successful:
            breakdown = r.get("timing_breakdown", {})
            for key, val in breakdown.items():
                if key not in timing_aggregates:
                    timing_aggregates[key] = []
                timing_aggregates[key].append(val)
        
        timing_summary = {}
        for key, vals in timing_aggregates.items():
            if vals:
                timing_summary[key] = {
                    "min": round(min(vals), 1),
                    "avg": round(sum(vals) / len(vals), 1),
                    "max": round(max(vals), 1),
                }
        
        error_breakdown = {}
        for r in failed:
            key = (r.get("error") or "Unknown")[:50]
            error_breakdown[key] = error_breakdown.get(key, 0) + 1
        
        summary = {
            "type": "summary",
            "total_requests": num_requests,
            "successful": len(successful),
            "failed": len(failed),
            "total_time": round(total_time, 2),
            "throughput": round(num_requests / total_time, 2) if total_time > 0 else 0,
            # Thread creation times (setup before agent runs)
            "min_thread_creation_time": round(min(thread_times), 3) if thread_times else 0,
            "avg_thread_creation_time": round(sum(thread_times) / len(thread_times), 3) if thread_times else 0,
            "max_thread_creation_time": round(max(thread_times), 3) if thread_times else 0,
            # Time to first response (agent execution time until first chunk)
            "first_response_measured": len(first_response_times),
            "min_time_to_first_response": round(min(first_response_times), 3) if first_response_times else None,
            "avg_time_to_first_response": round(sum(first_response_times) / len(first_response_times), 3) if first_response_times else None,
            "max_time_to_first_response": round(max(first_response_times), 3) if first_response_times else None,
            # Total TTFT (end-to-end from request to first response)
            "min_total_ttft": round(min(total_ttft_times), 3) if total_ttft_times else None,
            "avg_total_ttft": round(sum(total_ttft_times) / len(total_ttft_times), 3) if total_ttft_times else None,
            "max_total_ttft": round(max(total_ttft_times), 3) if total_ttft_times else None,
            # Actual LLM TTFT (pure LiteLLM call time, from llm.py)
            "llm_ttft_measured": len(llm_ttft_times),
            "min_llm_ttft": round(min(llm_ttft_times), 3) if llm_ttft_times else None,
            "avg_llm_ttft": round(sum(llm_ttft_times) / len(llm_ttft_times), 3) if llm_ttft_times else None,
            "max_llm_ttft": round(max(llm_ttft_times), 3) if llm_ttft_times else None,
            # Detailed timing breakdown
            "timing_breakdown": timing_summary,
            "error_breakdown": error_breakdown,
        }
        
        yield json.dumps(summary) + "\n"
        
        logger.info(f"Stress test completed: {len(successful)}/{num_requests} successful in {total_time:.2f}s")
    
    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        }
    )


@router.get("/limits")
async def get_current_limits(
    admin: dict = Depends(require_super_admin)
):
    """Get current concurrent run limits for the admin's account."""
    from core.utils.limits_checker import check_agent_run_limit
    
    account_id = admin.get("user_id")
    if not account_id:
        raise HTTPException(status_code=400, detail="Could not determine admin account ID")
    
    limits = await check_agent_run_limit(account_id)
    
    return {
        "account_id": account_id,
        "current_running": limits.get("running_count", 0),
        "concurrent_limit": limits.get("limit", 20),
        "can_start": limits.get("can_start", True),
        "running_thread_ids": limits.get("running_thread_ids", []),
    }
