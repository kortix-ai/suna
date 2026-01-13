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


from core.versioning.api import router as versioning_router
from core.agents.api import router as agent_runs_router
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
from core.admin.stress_test_admin_api import router as stress_test_admin_router
from core.admin.system_status_admin_api import router as system_status_admin_router
from core.endpoints.system_status_api import router as system_status_router
from core.services import transcription as transcription_api
import sys
from core.triggers import api as triggers_api
from core.services import api_keys_api
from core.notifications import api as notifications_api
from core.services.orphan_cleanup import cleanup_orphaned_agent_runs


if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

db = DBConnection()
# Use shared instance ID for distributed deployments
from core.utils.instance import get_instance_id, INSTANCE_ID
instance_id = INSTANCE_ID  # Keep backward compatibility


# Rate limiter state
ip_tracker = OrderedDict()
MAX_CONCURRENT_IPS = 25

# Background task handles
_worker_metrics_task = None
_memory_watchdog_task = None
_stream_cleanup_task = None

# Graceful shutdown flag for health checks
# When True, health check will return unhealthy to stop receiving traffic
_is_shutting_down = False

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _worker_metrics_task, _memory_watchdog_task, _stream_cleanup_task, _is_shutting_down
    env_mode = config.ENV_MODE.value if config.ENV_MODE else "unknown"
    logger.debug(f"Starting up FastAPI application with instance ID: {instance_id} in {env_mode} mode")
    try:
        await db.initialize()
        
        from core.services.db import init_db
        await init_db()
        
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
        
        # ===== Cleanup orphaned agent runs from previous instance =====
        # On startup, ALL runs with status='running' are orphans from the previous instance
        # Also cleans up orphaned Redis streams without matching DB records
        try:
            client = await db.client
            await cleanup_orphaned_agent_runs(client)
        except Exception as e:
            logger.error(f"Failed to cleanup orphaned agent runs on startup: {e}")
        
        # Start background tasks
        # asyncio.create_task(core_api.restore_running_agent_runs())
        
        triggers_api.initialize(db)
        credentials_api.initialize(db)
        template_api.initialize(db)
        composio_api.initialize(db)
        
        # Start CloudWatch worker metrics publisher (production only)
        if config.ENV_MODE == EnvMode.PRODUCTION:
            from core.services import worker_metrics
            _worker_metrics_task = asyncio.create_task(worker_metrics.start_cloudwatch_publisher())
        
        # Start Redis stream cleanup task (catches orphaned streams with no TTL)
        from core.services import worker_metrics
        _stream_cleanup_task = asyncio.create_task(worker_metrics.start_stream_cleanup_task())
        
        # Start memory watchdog for observability
        _memory_watchdog_task = asyncio.create_task(_memory_watchdog())
        
        yield

        # Shutdown sequence: Set flag first so health checks fail
        _is_shutting_down = True
        logger.info(f"Starting graceful shutdown for instance {instance_id}")
        
        # Give K8s readiness probe time to detect unhealthy state
        # This ensures no new traffic is routed to this pod
        await asyncio.sleep(2)
        
        # ===== CRITICAL: Stop all running agent runs on this instance =====
        from core.agents.api import _cancellation_events
        from core.agents.runner.agent_runner import update_agent_run_status
        
        active_run_ids = list(_cancellation_events.keys())
        if active_run_ids:
            logger.warning(f"🛑 Stopping {len(active_run_ids)} active agent runs on shutdown: {active_run_ids}")
            
            # Set cancellation events for all running runs
            for agent_run_id in active_run_ids:
                try:
                    event = _cancellation_events.get(agent_run_id)
                    if event:
                        event.set()
                        logger.info(f"Set cancellation event for {agent_run_id}")
                except Exception as e:
                    logger.error(f"Failed to set cancellation event for {agent_run_id}: {e}")
            
            # Give tasks a moment to handle cancellation gracefully
            await asyncio.sleep(1)
            
            # Force update DB status for any runs that didn't clean up
            for agent_run_id in active_run_ids:
                try:
                    # Update status to stopped with shutdown message
                    await update_agent_run_status(
                        agent_run_id,
                        "stopped",
                        error=f"Instance shutdown: {instance_id}"
                    )
                    logger.info(f"✅ Marked agent run {agent_run_id} as stopped (instance shutdown)")
                    
                    # Also set Redis stop signal for any reconnecting clients
                    try:
                        await redis.set_stop_signal(agent_run_id)
                    except Exception:
                        pass
                except Exception as e:
                    logger.error(f"Failed to update agent run {agent_run_id} on shutdown: {e}")
        else:
            logger.info("No active agent runs to stop on shutdown")
        
        logger.debug("Cleaning up resources")
        
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
        
        # Close direct Postgres connection pool
        from core.services.db import close_db
        await close_db()
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
allowed_origins = ["https://www.kortix.com", "https://kortix.com", "https://prod-test.kortix.com"]
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
api_router.include_router(stress_test_admin_router)
api_router.include_router(system_status_admin_router)
api_router.include_router(system_status_router)

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

from core.test_harness.api import router as test_harness_router, e2e_router
api_router.include_router(test_harness_router)
api_router.include_router(e2e_router)

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
async def metrics_endpoint():
    """
    Get API instance metrics for monitoring.
    
    Returns:
        - active_agent_runs: Total active runs across all instances (from DB)
        - active_redis_streams: Active Redis stream keys
        - orphaned_streams: Streams without DB records (should be 0)
    """
    from core.services import worker_metrics
    
    try:
        return await worker_metrics.get_worker_metrics()
    except Exception as e:
        logger.error(f"Failed to get metrics: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get metrics: {str(e)}")

@api_router.get("/debug", summary="Debug Information", operation_id="debug", tags=["system"])
async def debug_endpoint():
    """Get basic debug information for troubleshooting."""
    from core.agents.api import _cancellation_events
    
    return {
        "instance_id": instance_id,
        "active_runs_on_instance": len(_cancellation_events),
        "is_shutting_down": _is_shutting_down,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }

@api_router.get("/debug/redis", summary="Redis Health & Diagnostics", operation_id="redis_health", tags=["system"])
async def redis_health_endpoint():
    """
    Get detailed Redis health and pool diagnostics.
    
    Returns:
        - status: healthy, degraded, or unhealthy
        - latency_ms: ping latency in milliseconds
        - pool: connection pool statistics
        - timeouts: configured timeout values
    """
    try:
        health_data = await redis.health_check()
        
        # Add instance info
        health_data["instance_id"] = instance_id
        health_data["timestamp"] = datetime.now(timezone.utc).isoformat()
        
        # Return appropriate status code
        if health_data.get("status") == "unhealthy":
            return JSONResponse(status_code=503, content=health_data)
        elif health_data.get("status") == "degraded":
            return JSONResponse(status_code=200, content=health_data)
        else:
            return health_data
    except Exception as e:
        logger.error(f"Redis health check failed: {e}")
        return JSONResponse(
            status_code=503,
            content={
                "status": "unhealthy",
                "error": str(e),
                "instance_id": instance_id,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
        )

@api_router.get("/health-docker", summary="Docker Health Check", operation_id="health_check_docker", tags=["system"])
async def health_check_docker():
    logger.debug("Health docker check endpoint called")
    try:
        client = await redis.get_client()
        await client.ping()
        # Use the global db singleton instead of creating a new instance
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
    """Monitor worker memory and detect stale agent runs.
    
    Dynamically calculates per-worker memory limit based on total RAM and worker count.
    Also tracks _cancellation_events and lifecycle_tracker for cleanup failure detection.
    """
    import time as time_module
    
    # Calculate per-worker memory limit dynamically
    workers = int(os.getenv("WORKERS", "16"))
    total_ram_mb = psutil.virtual_memory().total / 1024 / 1024
    per_worker_limit_mb = (total_ram_mb * 0.8) / workers
    
    critical_threshold_mb = per_worker_limit_mb * 0.87
    warning_threshold_mb = per_worker_limit_mb * 0.80
    info_threshold_mb = per_worker_limit_mb * 0.67
    
    logger.info(
        f"Memory watchdog started: {total_ram_mb/1024:.1f}GB total, "
        f"{per_worker_limit_mb/1024:.1f}GB per worker ({workers} workers)"
    )
    
    try:
        while True:
            try:
                process = psutil.Process()
                mem_info = process.memory_info()
                mem_mb = mem_info.rss / 1024 / 1024
                mem_percent = (mem_mb / per_worker_limit_mb) * 100
                
                # === NEW: Cleanup state tracking ===
                from core.agents.api import _cancellation_events
                try:
                    from core.utils.lifecycle_tracker import get_active_runs
                    active_runs = get_active_runs()
                    stale_runs = [
                        rid for rid, start in active_runs.items() 
                        if (time_module.time() - start) > 3600  # > 1 hour
                    ]
                except ImportError:
                    active_runs = {}
                    stale_runs = []
                
                cancellation_count = len(_cancellation_events)
                active_count = len(active_runs)
                stale_count = len(stale_runs)
                
                # Always log cleanup state if there are issues
                if stale_count > 0 or cancellation_count > 10:
                    logger.warning(
                        f"[WATCHDOG] mem={mem_mb:.0f}MB "
                        f"cancellation_events={cancellation_count} "
                        f"active_runs={active_count} "
                        f"stale_runs={stale_count} "
                        f"instance={instance_id}"
                    )
                    if stale_runs:
                        logger.warning(f"[WATCHDOG] stale_run_ids={stale_runs[:5]}")
                # === END NEW ===
                
                # Existing memory threshold logging
                if mem_mb > critical_threshold_mb:
                    logger.error(
                        f"🚨 CRITICAL: Worker memory {mem_mb:.0f}MB ({mem_percent:.1f}%) "
                        f"cancellation_events={cancellation_count} "
                        f"active_runs={active_count} "
                        f"instance={instance_id}"
                    )
                    import gc
                    gc.collect()
                elif mem_mb > warning_threshold_mb:
                    logger.warning(
                        f"⚠️ Worker memory high: {mem_mb:.0f}MB ({mem_percent:.1f}%) "
                        f"cancellation_events={cancellation_count} "
                        f"instance={instance_id}"
                    )
                elif mem_mb > info_threshold_mb:
                    logger.info(
                        f"Worker memory: {mem_mb:.0f}MB ({mem_percent:.1f}%) "
                        f"cancellation_events={cancellation_count} "
                        f"instance={instance_id}"
                    )
                
            except Exception as e:
                logger.debug(f"Memory watchdog error: {e}")
            
            await asyncio.sleep(60)
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