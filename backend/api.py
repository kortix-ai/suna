from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, Request, HTTPException, Response, Depends, APIRouter, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from core.services import redis
from core.utils.openapi_config import configure_openapi
from contextlib import asynccontextmanager
from core.agentpress.thread_manager import ThreadManager
from core.services.supabase import DBConnection
from datetime import datetime, timezone
from core.utils.config import config, EnvMode
import asyncio
from core.utils.logger import logger, structlog
import time
from collections import OrderedDict
import os
import psutil

from pydantic import BaseModel
import uuid

from core.utils.rate_limiter import (
    auth_rate_limiter,
    api_key_rate_limiter,
    admin_rate_limiter,
    get_client_identifier,
)

from core.versioning.api import router as versioning_router
from core.agents.runs import router as agent_runs_router
from core.agents.agent_crud import router as agent_crud_router
from core.agents.agent_tools import router as agent_tools_router
from core.agents.agent_json import router as agent_json_router
from core.agents.agent_setup import router as agent_setup_router
from core.threads.api import router as threads_router
from core.categorization.api import router as categorization_router
from core.endpoints import router as endpoints_router

from core.sandbox import api as sandbox_api
from core.billing.api import router as billing_router
from core.setup import router as setup_router, webhook_router
from core.admin.admin_api import router as admin_router
from core.admin.billing_admin_api import router as billing_admin_router
from core.admin.feedback_admin_api import router as feedback_admin_router
from core.admin.notification_admin_api import router as notification_admin_router
from core.admin.analytics_admin_api import router as analytics_admin_router
from core.services import transcription as transcription_api
import sys
from core.triggers import api as triggers_api
from core.services import api_keys_api
from core.notifications import api as notifications_api


if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

db = DBConnection()
# Generate unique instance ID per process/worker
# This is critical for distributed locking - each worker needs a unique ID
import uuid
instance_id = str(uuid.uuid4())[:8]

# Rate limiter state
ip_tracker = OrderedDict()
MAX_CONCURRENT_IPS = 25

# Background task handle for CloudWatch metrics
_queue_metrics_task = None
_worker_metrics_task = None
_memory_watchdog_task = None

# Graceful shutdown flag for health checks
# When True, health check will return unhealthy to stop receiving traffic
_is_shutting_down = False

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _queue_metrics_task, _worker_metrics_task, _memory_watchdog_task, _is_shutting_down
    env_mode = config.ENV_MODE.value if config.ENV_MODE else "unknown"
    logger.debug(f"Starting up FastAPI application with instance ID: {instance_id} in {env_mode} mode")
    try:
        await db.initialize()
        
        # Pre-load tool classes and schemas to avoid first-request delay
        from core.utils.tool_discovery import warm_up_tools_cache
        warm_up_tools_cache()
        
        # Pre-load static Suna config for fast path in API requests
        from core.cache.runtime_cache import load_static_suna_config
        load_static_suna_config()
        
        sandbox_api.initialize(db)
        
        # Initialize Redis connection
        from core.services import redis
        try:
            await redis.initialize_async()
            logger.debug("Redis connection initialized successfully")
        except Exception as e:
            logger.error(f"Failed to initialize Redis connection: {e}")
            # Continue without Redis - the application will handle Redis failures gracefully
        
        # Start background tasks
        # asyncio.create_task(core_api.restore_running_agent_runs())
        
        triggers_api.initialize(db)
        credentials_api.initialize(db)
        template_api.initialize(db)
        composio_api.initialize(db)
        
        # Start CloudWatch queue metrics publisher (production only)
        if config.ENV_MODE == EnvMode.PRODUCTION:
            from core.services import queue_metrics
            _queue_metrics_task = asyncio.create_task(queue_metrics.start_cloudwatch_publisher())
            
            # Start CloudWatch worker metrics publisher
            from core.services import worker_metrics
            _worker_metrics_task = asyncio.create_task(worker_metrics.start_cloudwatch_publisher())
        
        # Start memory watchdog for observability
        _memory_watchdog_task = asyncio.create_task(_memory_watchdog())
        
        yield

        # Shutdown sequence: Set flag first so health checks fail
        _is_shutting_down = True
        logger.info(f"Starting graceful shutdown for instance {instance_id}")
        
        # Give K8s readiness probe time to detect unhealthy state
        # This ensures no new traffic is routed to this pod
        await asyncio.sleep(2)
        
        logger.debug("Cleaning up resources")
        
        # Stop CloudWatch queue metrics task
        if _queue_metrics_task is not None:
            _queue_metrics_task.cancel()
            try:
                await _queue_metrics_task
            except asyncio.CancelledError:
                pass
        
        # Stop CloudWatch worker metrics task
        if _worker_metrics_task is not None:
            _worker_metrics_task.cancel()
            try:
                await _worker_metrics_task
            except asyncio.CancelledError:
                pass
        
        # Stop memory watchdog task
        if _memory_watchdog_task is not None:
            _memory_watchdog_task.cancel()
            try:
                await _memory_watchdog_task
            except asyncio.CancelledError:
                pass
        
        try:
            logger.debug("Closing Redis connection")
            await redis.close()
            logger.debug("Redis connection closed successfully")
        except Exception as e:
            logger.error(f"Error closing Redis connection: {e}")

        logger.debug("Disconnecting from database")
        await db.disconnect()
    except Exception as e:
        logger.error(f"Error during application startup: {e}")
        raise

app = FastAPI(
    lifespan=lifespan,
    swagger_ui_parameters={
        "persistAuthorization": True,  # Keep auth between page refreshes
    },
)

# Configure OpenAPI docs with API Key and Bearer token auth
configure_openapi(app)

@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    """Apply rate limiting to sensitive endpoints."""
    path = request.url.path
    
    # Skip rate limiting for health checks and OPTIONS requests
    if path in ["/v1/health", "/v1/health-docker"] or request.method == "OPTIONS":
        return await call_next(request)
    
    # Get client identifier
    client_id = get_client_identifier(request)
    
    # Apply appropriate rate limiter based on path
    rate_limiter = None
    
    if "/v1/api-keys" in path:
        rate_limiter = api_key_rate_limiter
    elif "/v1/admin" in path:
        rate_limiter = admin_rate_limiter
    elif any(sensitive in path for sensitive in ["/v1/setup/initialize", "/v1/billing/webhook"]):
        rate_limiter = auth_rate_limiter
    
    if rate_limiter:
        is_limited, retry_after = rate_limiter.is_rate_limited(client_id)
        if is_limited:
            logger.warning(f"Rate limited: {path} from {client_id[:8]}...")
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests. Please try again later."},
                headers={"Retry-After": str(retry_after)}
            )
    
    return await call_next(request)


@app.middleware("http")
async def log_requests_middleware(request: Request, call_next):
    structlog.contextvars.clear_contextvars()

    request_id = str(uuid.uuid4())
    start_time = time.time()
    client_ip = request.client.host if request.client else "unknown"
    method = request.method
    path = request.url.path
    query_params = str(request.query_params)

    structlog.contextvars.bind_contextvars(
        request_id=request_id,
        client_ip=client_ip,
        method=method,
        path=path,
        query_params=query_params
    )

    # Log the incoming request
    logger.debug(f"Request started: {method} {path} from {client_ip} | Query: {query_params}")
    
    try:
        response = await call_next(request)
        process_time = time.time() - start_time
        logger.debug(f"Request completed: {method} {path} | Status: {response.status_code} | Time: {process_time:.2f}s")
        return response
    except Exception as e:
        process_time = time.time() - start_time
        try:
            error_str = str(e)
        except Exception:
            error_str = f"Error of type {type(e).__name__}"
        logger.error(f"Request failed: {method} {path} | Error: {error_str} | Time: {process_time:.2f}s")
        raise

# Define allowed origins based on environment
allowed_origins = ["https://www.kortix.com", "https://kortix.com"]
allow_origin_regex = None

# Add staging-specific origins
if config.ENV_MODE == EnvMode.LOCAL:
    allowed_origins.append("http://localhost:3000")
    allowed_origins.append("http://127.0.0.1:3000")

# Add staging-specific origins
if config.ENV_MODE == EnvMode.STAGING:
    allowed_origins.append("https://staging.suna.so")
    allowed_origins.append("http://localhost:3000")
    # Allow Vercel preview deployments
    allow_origin_regex = r"https://.*-kortixai\.vercel\.app"

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=allow_origin_regex,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Project-Id", "X-MCP-URL", "X-MCP-Type", "X-MCP-Headers", "X-API-Key"],
)

# Create a main API router
api_router = APIRouter()

# Include all API routers without individual prefixes
# Core routers
api_router.include_router(versioning_router)
api_router.include_router(agent_runs_router)
api_router.include_router(agent_crud_router)
api_router.include_router(agent_tools_router)
api_router.include_router(agent_json_router)
api_router.include_router(agent_setup_router)
api_router.include_router(threads_router)
api_router.include_router(categorization_router)
api_router.include_router(endpoints_router)
api_router.include_router(sandbox_api.router)
api_router.include_router(billing_router)
api_router.include_router(setup_router)
api_router.include_router(webhook_router)  # Webhooks at /api/webhooks/*
api_router.include_router(api_keys_api.router)
api_router.include_router(billing_admin_router)
api_router.include_router(admin_router)
api_router.include_router(feedback_admin_router)
api_router.include_router(notification_admin_router)
api_router.include_router(analytics_admin_router)

from core.mcp_module import api as mcp_api
from core.credentials import api as credentials_api
from core.templates import api as template_api
from core.templates import presentations_api

api_router.include_router(mcp_api.router)
api_router.include_router(credentials_api.router, prefix="/secure-mcp")
api_router.include_router(template_api.router, prefix="/templates")
api_router.include_router(presentations_api.router, prefix="/presentation-templates")

api_router.include_router(transcription_api.router)

from core.knowledge_base import api as knowledge_base_api
api_router.include_router(knowledge_base_api.router)

api_router.include_router(triggers_api.router)

api_router.include_router(notifications_api.router)

from core.notifications import presence_api
api_router.include_router(presence_api.router)

from core.composio_integration import api as composio_api
api_router.include_router(composio_api.router)

from core.google.google_slides_api import router as google_slides_router
api_router.include_router(google_slides_router)

from core.google.google_docs_api import router as google_docs_router
api_router.include_router(google_docs_router)

from core.referrals import router as referrals_router
from core.memory.api import router as memory_router
api_router.include_router(referrals_router)
api_router.include_router(memory_router)

from core.test_harness.api import router as test_harness_router
api_router.include_router(test_harness_router)

from core.files import staged_files_router
api_router.include_router(staged_files_router, prefix="/files")

from core.sandbox.canvas_ai_api import router as canvas_ai_router
api_router.include_router(canvas_ai_router)

@api_router.get("/health", summary="Health Check", operation_id="health_check", tags=["system"])
async def health_check():
    logger.debug("Health check endpoint called")

    # During shutdown, return unhealthy status
    # This causes K8s readinessProbe to fail and removes pod from service endpoints
    if _is_shutting_down:
        logger.debug(f"Health check returning unhealthy (shutting down) for instance {instance_id}")
        raise HTTPException(
            status_code=503,
            detail={
                "status": "shutting_down",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "instance_id": instance_id
            }
        )
    
    return {
        "status": "ok",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "instance_id": instance_id,
    }

@api_router.get("/metrics", summary="System Metrics", operation_id="metrics", tags=["system"])
async def metrics_endpoint(
    type: str = Query("all", description="Metrics type: 'queue', 'workers', or 'all'")
):
    """
    Get system metrics for monitoring and auto-scaling.
    
    - **queue**: Redis Streams pending messages (for auto-scaling)
    - **workers**: Worker count and task utilization
    - **all**: Combined queue and worker metrics (default)
    """
    from core.services import queue_metrics, worker_metrics
    
    try:
        if type == "queue":
            return await queue_metrics.get_queue_metrics()
        elif type == "workers":
            return await worker_metrics.get_worker_metrics()
        else:  # type == "all" or default
            queue_data = await queue_metrics.get_queue_metrics()
            worker_data = await worker_metrics.get_worker_metrics()
            return {
                "queue": queue_data,
                "workers": worker_data,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
    except Exception as e:
        logger.error(f"Failed to get metrics: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get metrics: {str(e)}")

@api_router.get("/debug", summary="Debug Information", operation_id="debug", tags=["system"])
async def debug_endpoint(
    type: str = Query("streams", description="Debug type: 'streams' (queue) or 'worker'")
):
    """
    Get detailed debug information for troubleshooting.
    
    - **streams**: Detailed Redis Streams status with all consumer groups and keys
    - **worker**: Stream worker status and health check
    """
    try:
        from core.worker.consumer import get_stream_info, CONSUMER_GROUP
        from core.worker.tasks import StreamName
        
        if type == "worker":
            # Worker status (simplified)
            info = await get_stream_info()
            return {
                "status": "healthy" if not info.get("error") else "error",
                **info,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
        else:  # type == "streams" or default
            # Detailed queue debug info
            client = await redis.get_client()
            stream_info = await get_stream_info()
            
            # Get all stream-related keys for debugging
            all_stream_keys = await client.keys("suna:*")
            
            # Get pending messages summary
            streams_summary = {}
            total_pending = 0
            total_length = 0
            
            for stream_name in StreamName:
                stream_data = stream_info.get("streams", {}).get(stream_name.value, {})
                pending = stream_data.get("pending_count", 0)
                length = stream_data.get("length", 0)
                total_pending += pending
                total_length += length
                
                streams_summary[stream_name.value] = {
                    "length": length,
                    "pending": pending,
                    "consumers": stream_data.get("consumers", []),
                }
            
            return {
                "consumer_group": CONSUMER_GROUP,
                "streams": streams_summary,
                "totals": {
                    "pending_messages": total_pending,
                    "total_stream_length": total_length,
                },
                "all_stream_keys": [k if isinstance(k, str) else k.decode() for k in all_stream_keys[:20]],
                "redis_connected": True,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
    except Exception as e:
        logger.error(f"Debug endpoint failed: {e}")
        return {
            "status": "error",
            "error": str(e),
            "redis_connected": False,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }

@api_router.get("/health-docker", summary="Docker Health Check", operation_id="health_check_docker", tags=["system"])
async def health_check_docker():
    logger.debug("Health docker check endpoint called")
    try:
        client = await redis.get_client()
        await client.ping()
        db = DBConnection()
        await db.initialize()
        db_client = await db.client
        await db_client.table("threads").select("thread_id").limit(1).execute()
        logger.debug("Health docker check complete")
        return {
            "status": "ok", 
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "instance_id": instance_id
        }
    except Exception as e:
        logger.error(f"Failed health docker check: {e}")
        raise HTTPException(status_code=500, detail="Health check failed")


app.include_router(api_router, prefix="/v1")


async def _memory_watchdog():
    """Monitor worker memory usage and log warnings when thresholds are exceeded.
    
    Memory thresholds (for 7.5GB limit):
    - Critical (>6.5GB / 87%): Immediate action needed, risk of OOM kill
    - Warning (>6GB / 80%): High memory usage, consider cleanup
    - Info (>5GB / 67%): Elevated memory usage
    """
    try:
        while True:
            try:
                process = psutil.Process()
                mem_info = process.memory_info()
                mem_mb = mem_info.rss / 1024 / 1024  # Convert to MB
                mem_percent = (mem_mb / 7680) * 100  # Percentage of 7.5GB limit
                
                # Critical threshold: >6.5GB (87% of 7.5GB limit) - risk of OOM kill
                if mem_mb > 6500:
                    logger.error(
                        f"🚨 CRITICAL: Worker memory very high: {mem_mb:.0f}MB ({mem_percent:.1f}%) "
                        f"(instance: {instance_id}) - Risk of OOM kill!"
                    )
                    # Try to force garbage collection when memory is critical
                    try:
                        import gc
                        collected = gc.collect()
                        if collected > 0:
                            logger.info(f"Emergency GC collected {collected} objects")
                    except Exception:
                        pass
                # Warning threshold: >6GB (80% of 7.5GB limit)
                elif mem_mb > 6000:
                    logger.warning(
                        f"⚠️ Worker memory high: {mem_mb:.0f}MB ({mem_percent:.1f}%) "
                        f"(instance: {instance_id}) - Approaching limit"
                    )
                # Info threshold: >5GB (67% of 7.5GB limit)
                elif mem_mb > 5000:
                    logger.info(
                        f"Worker memory: {mem_mb:.0f}MB ({mem_percent:.1f}%) "
                        f"(instance: {instance_id})"
                    )
                
            except Exception as e:
                logger.debug(f"Memory watchdog error: {e}")
            
            await asyncio.sleep(60)  # Check every minute
    except asyncio.CancelledError:
        logger.debug("Memory watchdog cancelled")
    except Exception as e:
        logger.error(f"Memory watchdog failed: {e}")


if __name__ == "__main__":
    import uvicorn
    
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    
    # Enable reload mode for local and staging environments
    is_dev_env = config.ENV_MODE in [EnvMode.LOCAL, EnvMode.STAGING]
    workers = 1 if is_dev_env else 4
    reload = is_dev_env
    
    logger.debug(f"Starting server on 0.0.0.0:8000 with {workers} workers (reload={reload})")
    uvicorn.run(
        "api:app", 
        host="0.0.0.0", 
        port=8000,
        workers=workers,
        loop="asyncio",
        reload=False if is_dev_env else False
    )