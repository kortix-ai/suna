#!/usr/bin/env python3
import asyncio
import time
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
load_dotenv()

if not os.environ.get("AWS_REGION"):
    os.environ["AWS_REGION"] = "us-west-2"
if not os.environ.get("AWS_DEFAULT_REGION"):
    os.environ["AWS_DEFAULT_REGION"] = "us-west-2"

VERBOSE = False
LARGE_PROMPT = False
LARGE_PROMPT_TOKENS = 10000

def generate_large_prompt(target_tokens: int = 10000) -> str:
    base = "You are a helpful AI assistant. " * 100
    multiplier = max(1, target_tokens // 400)
    return base * multiplier

CACHED_LARGE_PROMPT = None

def get_large_prompt():
    global CACHED_LARGE_PROMPT
    if CACHED_LARGE_PROMPT is None:
        CACHED_LARGE_PROMPT = generate_large_prompt(LARGE_PROMPT_TOKENS)
        print(f"  Generated large prompt: ~{len(CACHED_LARGE_PROMPT.split())} words, ~{len(CACHED_LARGE_PROMPT)//4} tokens")
    return CACHED_LARGE_PROMPT

async def make_single_call(call_id: int, model: str, semaphore_test: bool = False):
    from core.services.llm import make_llm_api_call, LLMError
    
    start = time.monotonic()
    
    if LARGE_PROMPT:
        messages = [
            {"role": "system", "content": get_large_prompt()},
            {"role": "user", "content": f"Say 'ok {call_id}' and nothing else."}
        ]
    else:
        messages = [
            {"role": "user", "content": f"Say 'ok {call_id}' and nothing else."}
        ]
    
    try:
        response = await make_llm_api_call(
            messages=messages,
            model_name=model,
            stream=True,
            max_tokens=10,
        )
        
        chunks = 0
        content = ""
        async for chunk in response:
            chunks += 1
            if hasattr(chunk, 'choices') and chunk.choices:
                delta = chunk.choices[0].delta
                if hasattr(delta, 'content') and delta.content:
                    content += delta.content
        
        elapsed = time.monotonic() - start
        
        if VERBOSE:
            print(f"    [{call_id}] {elapsed:.2f}s: {content.strip()[:60]}")
        
        return {"id": call_id, "status": "success", "time": elapsed, "chunks": chunks, "content": content}
        
    except LLMError as e:
        elapsed = time.monotonic() - start
        if VERBOSE:
            print(f"    [{call_id}] ERROR: {str(e)[:60]}")
        return {"id": call_id, "status": "error", "time": elapsed, "error": str(e)[:50]}
    except Exception as e:
        elapsed = time.monotonic() - start
        if VERBOSE:
            print(f"    [{call_id}] EXCEPTION: {str(e)[:60]}")
        return {"id": call_id, "status": "exception", "time": elapsed, "error": str(e)[:50]}


async def run_concurrent_test(
    num_requests: int = 20,
    model: str = "openai/gpt-4o-mini",
    batch_size: int = 10,
):
    print(f"\n{'='*60}")
    print(f"LLM Concurrency Test")
    print(f"{'='*60}")
    print(f"Model: {model}")
    print(f"Total requests: {num_requests}")
    print(f"Batch size: {batch_size}")
    print(f"Large prompt mode: {LARGE_PROMPT}")
    if LARGE_PROMPT:
        est_tokens = LARGE_PROMPT_TOKENS * num_requests
        print(f"Est. total tokens: ~{est_tokens:,} ({est_tokens/1000:.0f}k)")
    print(f"Redis limiter: {os.environ.get('LLM_USE_REDIS_LIMITER', 'false')}")
    
    from core.services.llm import LLM_INFLIGHT_LIMIT, USE_REDIS_LIMITER, LLM_GLOBAL_LIMIT
    print(f"Local semaphore limit: {LLM_INFLIGHT_LIMIT}")
    if USE_REDIS_LIMITER:
        print(f"Global Redis limit: {LLM_GLOBAL_LIMIT}")
    print(f"{'='*60}\n")
    
    all_results = []
    
    for batch_start in range(0, num_requests, batch_size):
        batch_end = min(batch_start + batch_size, num_requests)
        batch_ids = range(batch_start, batch_end)
        
        print(f"Starting batch {batch_start//batch_size + 1}: requests {batch_start}-{batch_end-1}")
        
        batch_start_time = time.monotonic()
        
        tasks = [make_single_call(i, model) for i in batch_ids]
        results = await asyncio.gather(*tasks)
        
        batch_elapsed = time.monotonic() - batch_start_time
        
        all_results.extend(results)
        
        successes = sum(1 for r in results if r["status"] == "success")
        errors = sum(1 for r in results if r["status"] != "success")
        avg_time = sum(r["time"] for r in results) / len(results)
        
        print(f"  ✓ {successes} success, ✗ {errors} errors, "
              f"avg: {avg_time:.2f}s, batch: {batch_elapsed:.2f}s")
        
        for r in results:
            if r["status"] != "success":
                print(f"    ✗ Request {r['id']}: {r.get('error', 'unknown')}")
    
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    
    total_success = sum(1 for r in all_results if r["status"] == "success")
    total_errors = sum(1 for r in all_results if r["status"] != "success")
    times = [r["time"] for r in all_results]
    
    print(f"Total: {num_requests} requests")
    print(f"Success: {total_success} ({100*total_success/num_requests:.1f}%)")
    print(f"Errors: {total_errors} ({100*total_errors/num_requests:.1f}%)")
    print(f"Min time: {min(times):.2f}s")
    print(f"Max time: {max(times):.2f}s")
    print(f"Avg time: {sum(times)/len(times):.2f}s")
    print(f"{'='*60}\n")
    
    return all_results


async def run_production_load(
    duration_seconds: int = 60,
    requests_per_second: float = 5.0,
    model: str = "kortix/basic",
):
    import random
    
    print(f"\n{'='*60}")
    print(f"PRODUCTION LOAD SIMULATION")
    print(f"{'='*60}")
    print(f"Model: {model}")
    print(f"Duration: {duration_seconds}s")
    print(f"Target rate: {requests_per_second} req/s")
    print(f"Redis limiter: {os.environ.get('LLM_USE_REDIS_LIMITER', 'false')}")
    
    from core.services.llm import LLM_INFLIGHT_LIMIT, USE_REDIS_LIMITER, LLM_GLOBAL_LIMIT
    print(f"Local semaphore limit: {LLM_INFLIGHT_LIMIT}")
    if USE_REDIS_LIMITER:
        print(f"Global Redis limit: {LLM_GLOBAL_LIMIT}")
    print(f"{'='*60}\n")
    
    stats = {
        "started": 0,
        "completed": 0,
        "failed": 0,
        "in_flight": 0,
        "total_time": 0.0,
        "min_time": float('inf'),
        "max_time": 0.0,
    }
    stats_lock = asyncio.Lock()
    
    async def tracked_call(call_id: int):
        async with stats_lock:
            stats["started"] += 1
            stats["in_flight"] += 1
        
        result = await make_single_call(call_id, model)
        
        async with stats_lock:
            stats["in_flight"] -= 1
            if result["status"] == "success":
                stats["completed"] += 1
                stats["total_time"] += result["time"]
                stats["min_time"] = min(stats["min_time"], result["time"])
                stats["max_time"] = max(stats["max_time"], result["time"])
            else:
                stats["failed"] += 1
        
        return result
    
    async def stats_printer():
        start = time.monotonic()
        while True:
            await asyncio.sleep(5)
            elapsed = time.monotonic() - start
            async with stats_lock:
                completed = stats["completed"]
                rate = completed / elapsed if elapsed > 0 else 0
                avg_time = stats["total_time"] / completed if completed > 0 else 0
                print(f"  [{elapsed:.0f}s] ✓{stats['completed']} ✗{stats['failed']} "
                      f"in-flight:{stats['in_flight']} rate:{rate:.1f}/s avg:{avg_time:.2f}s")
    
    async def request_generator():
        call_id = 0
        interval = 1.0 / requests_per_second
        start = time.monotonic()
        tasks = []
        
        while time.monotonic() - start < duration_seconds:
            task = asyncio.create_task(tracked_call(call_id))
            tasks.append(task)
            call_id += 1
            
            delay = random.expovariate(1.0 / interval)
            await asyncio.sleep(delay)
        
        print(f"\n  Waiting for {len([t for t in tasks if not t.done()])} in-flight requests...")
        await asyncio.gather(*tasks, return_exceptions=True)
    
    printer_task = asyncio.create_task(stats_printer())
    
    try:
        await request_generator()
    finally:
        printer_task.cancel()
        try:
            await printer_task
        except asyncio.CancelledError:
            pass
    
    print(f"\n{'='*60}")
    print("PRODUCTION LOAD SUMMARY")
    print(f"{'='*60}")
    print(f"Total requests: {stats['started']}")
    print(f"Completed: {stats['completed']} ({100*stats['completed']/stats['started']:.1f}%)")
    print(f"Failed: {stats['failed']} ({100*stats['failed']/stats['started']:.1f}%)")
    if stats['completed'] > 0:
        print(f"Avg latency: {stats['total_time']/stats['completed']:.2f}s")
        print(f"Min latency: {stats['min_time']:.2f}s")
        print(f"Max latency: {stats['max_time']:.2f}s")
    print(f"Throughput: {stats['completed']/duration_seconds:.2f} req/s")
    print(f"{'='*60}\n")


async def main():
    import argparse
    
    parser = argparse.ArgumentParser(description="Test LLM concurrency")
    parser.add_argument("-n", "--num", type=int, default=20, help="Number of requests")
    parser.add_argument("-b", "--batch", type=int, default=10, help="Batch size (concurrent)")
    parser.add_argument("-m", "--model", default="kortix/basic", help="Model to use (kortix/basic, kortix/power)")
    parser.add_argument("--redis", action="store_true", help="Use Redis limiter")
    parser.add_argument("--mock", action="store_true", help="Use mock LLM (no API calls)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Show LLM responses")
    parser.add_argument("--prod", action="store_true", help="Run production load simulation")
    parser.add_argument("-d", "--duration", type=int, default=60, help="Duration in seconds (for --prod)")
    parser.add_argument("-r", "--rate", type=float, default=5.0, help="Requests per second (for --prod)")
    parser.add_argument("--large-prompt", action="store_true", help="Use large system prompt (~10k tokens) to test TPM limits")
    parser.add_argument("--prompt-tokens", type=int, default=50000, help="Target tokens for large prompt (default: 10000)")
    
    args = parser.parse_args()
    
    if args.redis:
        os.environ["LLM_USE_REDIS_LIMITER"] = "true"
    
    if args.verbose:
        global VERBOSE
        VERBOSE = True
    
    if args.large_prompt:
        global LARGE_PROMPT, LARGE_PROMPT_TOKENS
        LARGE_PROMPT = True
        LARGE_PROMPT_TOKENS = args.prompt_tokens
        print(f"\n⚠️  LARGE PROMPT MODE: ~{args.prompt_tokens} tokens per request")
        print(f"   This tests TPM (Tokens Per Minute) limits\n")
    
    model = "mock-ai" if args.mock else args.model
    
    if args.prod:
        await run_production_load(
            duration_seconds=args.duration,
            requests_per_second=args.rate,
            model=model,
        )
    else:
        await run_concurrent_test(
            num_requests=args.num,
            model=model,
            batch_size=args.batch,
        )


if __name__ == "__main__":
    asyncio.run(main())
