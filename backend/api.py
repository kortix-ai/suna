from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from agentpress.thread_manager import ThreadManager
from services.supabase import DBConnection
from datetime import datetime, timezone
from dotenv import load_dotenv
import asyncio
from utils.logger import logger
import uuid

# Import the agent API module
from agent import api as agent_api
from sandbox import api as sandbox_api

# Load environment variables
load_dotenv()

# Initialize managers
db = DBConnection()
thread_manager = None
instance_id = str(uuid.uuid4())[:8]  # Generate instance ID at module load time

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    global thread_manager
    logger.info(f"Starting up FastAPI application with instance ID: {instance_id}")
    await db.initialize()
    thread_manager = ThreadManager()
    
    # Initialize the agent API with shared resources
    agent_api.initialize(
        thread_manager,
        db,
        instance_id  # Pass the instance_id to agent_api
    )
    
    # Initialize the sandbox API with shared resources
    sandbox_api.initialize(db)
    
    # Initialize Redis before restoring agent runs
    from services import redis
    await redis.initialize_async()
    
    asyncio.create_task(agent_api.restore_running_agent_runs())
    
    yield
    
    # Clean up agent resources (including Redis)
    logger.info("Cleaning up agent resources")
    await agent_api.cleanup()
    
    # Clean up database connection
    logger.info("Disconnecting from database")
    await db.disconnect()

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://www.suna.so", "https://suna.so", "https://staging.suna.so", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

# Include the agent router with a prefix
app.include_router(agent_api.router, prefix="/api")

# Include the sandbox router with a prefix
app.include_router(sandbox_api.router, prefix="/api")

@app.get("/api/health-check")
async def health_check():
    """Health check endpoint to verify API is working."""
    logger.info("Health check endpoint called")
    return {
        "status": "ok", 
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "instance_id": instance_id
    }

if __name__ == "__main__":
    import uvicorn
    logger.info("Starting server on 0.0.0.0:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000) 