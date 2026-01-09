"""
Admin Stress Test API
Runs stress tests by making actual HTTP calls to /agent/start endpoint.
This distributes load across workers like real production traffic.
Uses mock-ai model to avoid token costs.

TIMING:
- request_time: Total time for the HTTP request to complete
- timing_breakdown: Detailed timing returned directly in HTTP response (no Redis needed)
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

router = APIRouter(prefix="/admin/stress-test", tags=["admin-stress-test"])

# ============================================================================
# ALB MODE (for bypassing Cloudflare in production)
# ============================================================================
# Set STRESS_TEST_ALB_URL to hit ALB directly (bypasses Cloudflare, distributes across ECS).
# Leave unset for local/staging where Cloudflare isn't in the way.
#
# Example for prod:
#   STRESS_TEST_ALB_URL=https://your-alb-name.region.elb.amazonaws.com
#   STRESS_TEST_HOST_HEADER=api.yourdomain.com  (optional, defaults to api.kortix.com)
STRESS_TEST_ALB_URL = os.getenv("STRESS_TEST_ALB_URL")
STRESS_TEST_HOST_HEADER = os.getenv("STRESS_TEST_HOST_HEADER", "api.kortix.com")

# ============================================================================
# MODELS
# ============================================================================

class StressTestConfig(BaseModel):
    num_requests: int = 20
    batch_size: Optional[int] = None  # Defaults to num_requests (all at once)
    prompts: Optional[List[str]] = None

class StressTestResult(BaseModel):
    request_id: int
    status: str  # pending, running, done, error
    thread_id: Optional[str] = None
    project_id: Optional[str] = None
    agent_run_id: Optional[str] = None
    request_time: float = 0.0  # Time for HTTP request to complete
    error: Optional[str] = None
    # Detailed timing breakdown returned directly from HTTP response (no Redis needed)
    timing_breakdown: Optional[Dict[str, float]] = None

# Default prompts for stress testing
DEFAULT_PROMPTS = [
    "What is 2 + 2?",
    "Say hello",
    "Tell me a joke",
    "Count to 5",
    "What's your name?",
]


async def run_single_request_via_http(
    request_id: int,
    base_url: str,
    auth_token: str,
    prompt: str,
    host_header: Optional[str] = None,
    skip_ssl_verify: bool = False,
) -> Dict[str, Any]:
    """
    Run a single agent request by making an actual HTTP call.
    This gets distributed across workers like real traffic.
    Timing is returned directly in the HTTP response (no Redis needed).
    
    Args:
        host_header: If set, adds Host header (for ALB routing)
        skip_ssl_verify: If True, skip SSL verification (for ALB with AWS domain)
    """
    result = {
        "request_id": request_id,
        "status": "error",
        "thread_id": None,
        "project_id": None,
        "agent_run_id": None,
        "request_time": 0.0,
        "error": None,
    }
    
    start_time = time.time()
    
    try:
        async with httpx.AsyncClient(timeout=60.0, verify=not skip_ssl_verify) as client:
            # Build headers
            headers = {
                "Authorization": f"Bearer {auth_token}",
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Skip-Limits": "true",  # Bypass limits for stress testing (verified server-side)
                "X-Emit-Timing": "true",  # Return detailed timing breakdown in HTTP response
            }
            if host_header:
                headers["Host"] = host_header
            
            # Make actual HTTP call to /v1/agent/start with mock-ai model
            response = await client.post(
                f"{base_url}/v1/agent/start",
                headers=headers,
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
    
    # Determine target URL and mode
    # ALB mode: bypass Cloudflare, hit ALB directly with Host header (for prod ECS)
    # Normal mode: use request headers (for local/staging without Cloudflare)
    alb_url = STRESS_TEST_ALB_URL
    if alb_url:
        # ALB mode: bypass Cloudflare
        base_url = alb_url
        host_header = STRESS_TEST_HOST_HEADER
        skip_ssl_verify = True
        logger.info(f"Stress test using ALB mode: {base_url} with Host: {host_header}")
    else:
        # Normal mode: use incoming request headers
        base_url = os.getenv("STRESS_TEST_BASE_URL")
        if not base_url:
            scheme = request.headers.get("x-forwarded-proto", "http")
            host = request.headers.get("host", "localhost:8000")
            base_url = f"{scheme}://{host}"
        host_header = None
        skip_ssl_verify = False
    
    prompts = config.prompts or DEFAULT_PROMPTS
    num_requests = min(config.num_requests, 200)
    # Default batch_size to num_requests (all at once) if not specified
    batch_size = min(config.batch_size or num_requests, 300)
    
    logger.info(f"Admin stress test: {num_requests} requests, batch size {batch_size}, base_url={base_url}")
    
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
                    host_header=host_header,
                    skip_ssl_verify=skip_ssl_verify,
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
        
        error_breakdown = {}
        for r in failed:
            key = (r.get("error") or "Unknown")[:50]
            error_breakdown[key] = error_breakdown.get(key, 0) + 1
        
        # Aggregate timing breakdown stats (from HTTP response, no Redis needed)
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
            "error_breakdown": error_breakdown,
            # Detailed timing breakdown (from HTTP response, no Redis needed)
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
