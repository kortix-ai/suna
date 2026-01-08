"""
Admin Stress Test API
Runs stress tests by making actual HTTP calls to /agent/start endpoint.
This distributes load across workers like real production traffic.
Uses mock-ai model to avoid token costs.

TIMING DEFINITIONS:
- request_time: Total time for the HTTP request to complete (thread creation + agent start)
- time_to_first_response: Time from agent start until first LLM response chunk
- total_ttft: request_time + time_to_first_response
"""

from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.responses import StreamingResponse
from typing import Optional, List, Dict, Any
from pydantic import BaseModel
import asyncio
import json
import random
import time
import os
import httpx
from core.auth import require_super_admin
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
    request_time: float = 0.0  # Time for HTTP request to complete
    time_to_first_response: Optional[float] = None
    total_ttft: Optional[float] = None
    llm_ttft: Optional[float] = None
    error: Optional[str] = None
    # Detailed timing breakdown (when emit_timing is enabled)
    timing_breakdown: Optional[Dict[str, float]] = None

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
        self.first_response_ms: Optional[float] = None
        self.llm_ttft_seconds: Optional[float] = None


async def wait_for_timing_messages(agent_run_id: str, timeout: float = 120.0) -> TimingResult:
    """
    Subscribe to Redis stream and wait for timing messages.
    """
    stream_key = f"agent_run:{agent_run_id}:stream"
    start_time = time.time()
    last_id = "0"
    
    result = TimingResult()
    
    while time.time() - start_time < timeout:
        if result.first_response_ms is not None and result.llm_ttft_seconds is not None:
            break
            
        try:
            entries = await redis.xread({stream_key: last_id}, count=10, block=200)
            
            if entries:
                for stream_name, stream_entries in entries:
                    for entry_id, fields in stream_entries:
                        last_id = entry_id
                        try:
                            data_field = fields.get(b'data') or fields.get('data')
                            if isinstance(data_field, bytes):
                                data_field = data_field.decode()
                            
                            data = json.loads(data_field or '{}')
                            msg_type = data.get('type')
                            
                            if msg_type == 'timing' and 'first_response_ms' in data:
                                result.first_response_ms = data['first_response_ms']
                            
                            if msg_type == 'llm_ttft' and 'ttft_seconds' in data:
                                result.llm_ttft_seconds = data['ttft_seconds']
                            
                            if msg_type == 'status' and data.get('status') in ['completed', 'failed', 'stopped', 'error']:
                                return result
                        except Exception as e:
                            logger.debug(f"Error parsing stream message: {e}")
        except Exception as e:
            await asyncio.sleep(0.2)
    
    return result


async def run_single_request_via_http(
    request_id: int,
    base_url: str,
    auth_token: str,
    prompt: str,
    measure_ttft: bool = True,
    ttft_timeout: float = 120.0,
) -> Dict[str, Any]:
    """
    Run a single agent request by making an actual HTTP call.
    This gets distributed across workers like real traffic.
    """
    result = {
        "request_id": request_id,
        "status": "error",
        "thread_id": None,
        "project_id": None,
        "agent_run_id": None,
        "request_time": 0.0,
        "time_to_first_response": None,
        "total_ttft": None,
        "llm_ttft": None,
        "error": None,
    }
    
    start_time = time.time()
    
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            # Make actual HTTP call to /v1/agent/start with mock-ai model
            response = await client.post(
                f"{base_url}/v1/agent/start",
                headers={
                    "Authorization": f"Bearer {auth_token}",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-Skip-Limits": "true",  # Bypass limits for stress testing (verified server-side)
                    "X-Emit-Timing": "true",  # Emit detailed timing breakdown to Redis
                },
                data={
                    "prompt": prompt,
                    "model_name": "mock-ai",  # Always use mock to avoid token costs
                },
            )
            
            request_time = time.time() - start_time
            result["request_time"] = round(request_time, 3)
            
            if response.status_code != 200:
                result["error"] = f"HTTP {response.status_code}: {response.text}"
                return result
            
            data = response.json()
            logger.info(f"📊 Request {request_id} response: {data}")
            result["status"] = "done"
            result["thread_id"] = data.get("thread_id")
            result["project_id"] = data.get("project_id")
            result["agent_run_id"] = data.get("agent_run_id")
            
            # Get timing_breakdown directly from HTTP response (no Redis needed)
            if data.get("timing_breakdown"):
                logger.info(f"📊 Request {request_id} got timing_breakdown: {data['timing_breakdown']}")
                result["timing_breakdown"] = data["timing_breakdown"]
            else:
                logger.warning(f"📊 Request {request_id} NO timing_breakdown in response")
            
            # Wait for timing messages (first_response, llm_ttft) from Redis stream
            if measure_ttft and result["agent_run_id"]:
                timing_result = await wait_for_timing_messages(result["agent_run_id"], timeout=ttft_timeout)
                
                if timing_result.first_response_ms is not None:
                    result["time_to_first_response"] = round(timing_result.first_response_ms / 1000, 3)
                    result["total_ttft"] = round(request_time + (timing_result.first_response_ms / 1000), 3)
                
                if timing_result.llm_ttft_seconds is not None:
                    result["llm_ttft"] = round(timing_result.llm_ttft_seconds, 3)
    
    except httpx.TimeoutException:
        result["request_time"] = round(time.time() - start_time, 3)
        result["error"] = "Request timeout"
    except Exception as e:
        result["request_time"] = round(time.time() - start_time, 3)
        result["error"] = str(e)
        logger.error(f"Stress test request {request_id} failed: {result['error']}")
    
    return result


@router.post("/run")
async def run_stress_test(
    request: Request,
    config: StressTestConfig,
    admin: dict = Depends(require_super_admin)
):
    """
    Run a stress test by making actual HTTP calls to /agent/start.
    Requests are distributed across workers like real production traffic.
    Uses mock-ai model to avoid token costs.
    
    Returns results as a streaming JSON response for live updates.
    """
    # Extract auth token from the incoming request
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    auth_token = auth_header.split(" ", 1)[1]
    
    # Construct base URL from request headers (works through load balancers)
    # Safe because only super admins can call this endpoint
    base_url = os.getenv("STRESS_TEST_BASE_URL")
    if not base_url:
        scheme = request.headers.get("x-forwarded-proto", "http")
        host = request.headers.get("host", "localhost:8000")
        base_url = f"{scheme}://{host}"
    
    prompts = config.prompts or DEFAULT_PROMPTS
    num_requests = min(config.num_requests, 200)
    
    # Limit batch size based on Redis pool to prevent connection exhaustion
    # Each agent run uses multiple Redis connections, so limit concurrency
    redis_max = int(os.getenv("REDIS_MAX_CONNECTIONS", "50"))
    max_safe_batch = max(1, redis_max // 10)  # ~10 Redis ops per agent run
    batch_size = min(config.batch_size, 50, max_safe_batch)
    
    measure_ttft = config.measure_ttft
    ttft_timeout = config.ttft_timeout
    
    logger.info(f"Admin stress test: {num_requests} requests, batch size {batch_size} (redis_max={redis_max}), base_url={base_url}")
    
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
            "base_url": base_url,
        }) + "\n"
        
        for batch_num in range(num_batches):
            batch_start = batch_num * batch_size
            batch_end = min(batch_start + batch_size, num_requests)
            batch_ids = range(batch_start, batch_end)
            
            yield json.dumps({
                "type": "batch_start",
                "batch_num": batch_num + 1,
                "batch_start": batch_start,
                "batch_end": batch_end,
            }) + "\n"
            
            for req_id in batch_ids:
                yield json.dumps({
                    "type": "status",
                    "request_id": req_id,
                    "status": "running",
                }) + "\n"
            
            # Run batch concurrently - actual HTTP calls get distributed across workers
            tasks = [
                run_single_request_via_http(
                    request_id=req_id,
                    base_url=base_url,
                    auth_token=auth_token,
                    prompt=random.choice(prompts),
                    measure_ttft=measure_ttft,
                    ttft_timeout=ttft_timeout,
                )
                for req_id in batch_ids
            ]
            
            batch_results = await asyncio.gather(*tasks)
            all_results.extend(batch_results)
            
            for result in batch_results:
                yield json.dumps({
                    "type": "result",
                    **result,
                }) + "\n"
            
            if batch_num < num_batches - 1:
                await asyncio.sleep(0.5)
        
        # Calculate summary
        total_time = time.time() - start_time
        successful = [r for r in all_results if r["status"] == "done"]
        failed = [r for r in all_results if r["status"] == "error"]
        
        request_times = [r["request_time"] for r in all_results if r["request_time"] > 0]
        first_response_times = [r["time_to_first_response"] for r in all_results if r.get("time_to_first_response") is not None]
        total_ttft_times = [r["total_ttft"] for r in all_results if r.get("total_ttft") is not None]
        llm_ttft_times = [r["llm_ttft"] for r in all_results if r.get("llm_ttft") is not None]
        
        error_breakdown = {}
        for r in failed:
            key = (r.get("error") or "Unknown")[:50]
            error_breakdown[key] = error_breakdown.get(key, 0) + 1
        
        # Aggregate timing breakdown stats
        breakdown_keys = ["load_config_ms", "get_model_ms", "create_project_ms", 
                         "create_thread_ms", "create_message_and_run_ms", "total_setup_ms"]
        breakdown_stats = {}
        for key in breakdown_keys:
            values = [r["timing_breakdown"][key] for r in all_results 
                     if r.get("timing_breakdown") and r["timing_breakdown"].get(key) is not None]
            if values:
                breakdown_stats[key] = {
                    "min": round(min(values), 1),
                    "avg": round(sum(values) / len(values), 1),
                    "max": round(max(values), 1),
                    "count": len(values),
                }
        
        summary = {
            "type": "summary",
            "total_requests": num_requests,
            "successful": len(successful),
            "failed": len(failed),
            "total_time": round(total_time, 2),
            "throughput": round(num_requests / total_time, 2) if total_time > 0 else 0,
            # Request times (HTTP call duration)
            "min_request_time": round(min(request_times), 3) if request_times else 0,
            "avg_request_time": round(sum(request_times) / len(request_times), 3) if request_times else 0,
            "max_request_time": round(max(request_times), 3) if request_times else 0,
            # Time to first response
            "first_response_measured": len(first_response_times),
            "min_time_to_first_response": round(min(first_response_times), 3) if first_response_times else None,
            "avg_time_to_first_response": round(sum(first_response_times) / len(first_response_times), 3) if first_response_times else None,
            "max_time_to_first_response": round(max(first_response_times), 3) if first_response_times else None,
            # Total TTFT
            "min_total_ttft": round(min(total_ttft_times), 3) if total_ttft_times else None,
            "avg_total_ttft": round(sum(total_ttft_times) / len(total_ttft_times), 3) if total_ttft_times else None,
            "max_total_ttft": round(max(total_ttft_times), 3) if total_ttft_times else None,
            # LLM TTFT
            "llm_ttft_measured": len(llm_ttft_times),
            "min_llm_ttft": round(min(llm_ttft_times), 3) if llm_ttft_times else None,
            "avg_llm_ttft": round(sum(llm_ttft_times) / len(llm_ttft_times), 3) if llm_ttft_times else None,
            "max_llm_ttft": round(max(llm_ttft_times), 3) if llm_ttft_times else None,
            "error_breakdown": error_breakdown,
            # Detailed timing breakdown
            "timing_breakdown": breakdown_stats if breakdown_stats else None,
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
