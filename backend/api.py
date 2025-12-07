from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, Request, HTTPException, Response, Depends, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from core.services import redis
import sentry
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

from core import api as core_api

from core.sandbox import api as sandbox_api
from core.billing.api import router as billing_router
from core.setup import router as setup_router, webhook_router
from core.admin.admin_api import router as admin_router
from core.admin.billing_admin_api import router as billing_admin_router
from core.admin.notification_admin_api import router as notification_admin_router
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
_memory_watchdog_task = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _queue_metrics_task, _memory_watchdog_task
    env_mode = config.ENV_MODE.value if config.ENV_MODE else "unknown"
    logger.debug(f"Starting up FastAPI application with instance ID: {instance_id} in {env_mode} mode")
    try:
        await db.initialize()
        
        # Pre-load tool classes and schemas to avoid first-request delay
        from core.utils.tool_discovery import warm_up_tools_cache
        warm_up_tools_cache()
        
        # Pre-load static Suna config for fast path in API requests
        from core.runtime_cache import load_static_suna_config
        load_static_suna_config()
        
        core_api.initialize(
            db,
            instance_id
        )
        
        
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
        
        # Start memory watchdog for observability
        _memory_watchdog_task = asyncio.create_task(_memory_watchdog())
        
        yield
        
        logger.debug("Cleaning up agent resources")
        await core_api.cleanup()
        
        # Stop CloudWatch queue metrics task
        if _queue_metrics_task is not None:
            _queue_metrics_task.cancel()
            try:
                await _queue_metrics_task
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

app = FastAPI(lifespan=lifespan)

@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    """Apply rate limiting to sensitive endpoints."""
    path = request.url.path
    
    # Skip rate limiting for health checks and OPTIONS requests
    if path in ["/api/health", "/api/health-docker"] or request.method == "OPTIONS":
        return await call_next(request)
    
    # Get client identifier
    client_id = get_client_identifier(request)
    
    # Apply appropriate rate limiter based on path
    rate_limiter = None
    
    if "/api/api-keys" in path:
        rate_limiter = api_key_rate_limiter
    elif "/api/admin" in path:
        rate_limiter = admin_rate_limiter
    elif any(sensitive in path for sensitive in ["/api/setup/initialize", "/api/billing/webhook"]):
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
allowed_origins = ["https://www.kortix.com", "https://kortix.com", "https://www.suna.so", "https://suna.so"]
allow_origin_regex = None

# Add staging-specific origins
if config.ENV_MODE == EnvMode.LOCAL:
    allowed_origins.append("http://localhost:3000")
    allowed_origins.append("http://127.0.0.1:3000")

# Add staging-specific origins
if config.ENV_MODE == EnvMode.STAGING:
    allowed_origins.append("https://staging.suna.so")
    allowed_origins.append("http://localhost:3000")
    # Allow Vercel preview deployments for both legacy and new project names
    allow_origin_regex = r"https://(suna|kortixcom)-.*-prjcts\.vercel\.app"

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=allow_origin_regex,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Project-Id", "X-MCP-URL", "X-MCP-Type", "X-MCP-Headers", "X-Refresh-Token", "X-API-Key"],
)

# Create a main API router
api_router = APIRouter()

# Include all API routers without individual prefixes
api_router.include_router(core_api.router)
api_router.include_router(sandbox_api.router)
api_router.include_router(billing_router)
api_router.include_router(setup_router)
api_router.include_router(webhook_router)  # Webhooks at /api/webhooks/*
api_router.include_router(api_keys_api.router)
api_router.include_router(billing_admin_router)
api_router.include_router(admin_router)
api_router.include_router(notification_admin_router)

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
api_router.include_router(referrals_router)

from kortixpedia.main import router as kortixpedia_router
api_router.include_router(kortixpedia_router)

@api_router.get("/health", summary="Health Check", operation_id="health_check", tags=["system"])
async def health_check():
    logger.debug("Health check endpoint called")
    return {
        "status": "ok", 
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "instance_id": instance_id
    }

@api_router.get("/metrics/queue", summary="Queue Metrics", operation_id="queue_metrics", tags=["system"])
async def queue_metrics_endpoint():
    """Get Dramatiq queue depth for monitoring and auto-scaling."""
    from core.services import queue_metrics
    try:
        return await queue_metrics.get_queue_metrics()
    except Exception as e:
        logger.error(f"Failed to get queue metrics: {e}")
        raise HTTPException(status_code=500, detail="Failed to get queue metrics")

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


app.include_router(api_router, prefix="/api")


async def _memory_watchdog():
    """Monitor worker memory usage and log warnings when thresholds are exceeded."""
    try:
        while True:
            try:
                process = psutil.Process()
                mem_info = process.memory_info()
                mem_mb = mem_info.rss / 1024 / 1024  # Convert to MB
                
                # Log warning at 6GB (75% of 8GB hard limit)
                if mem_mb > 6000:
                    logger.warning(f"Worker memory high: {mem_mb:.0f}MB (instance: {instance_id})")
                # Log info at 5GB (62.5% of 8GB hard limit) for visibility
                elif mem_mb > 5000:
                    logger.info(f"Worker memory: {mem_mb:.0f}MB (instance: {instance_id})")
                
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
        loop="asyncio"
    )