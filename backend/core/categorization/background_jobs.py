"""Background jobs for project categorization."""
import dramatiq
import os
from datetime import datetime, timezone, timedelta
from core.utils.logger import logger
from core.services.supabase import DBConnection
from .service import categorize_from_messages

QUEUE_PREFIX = os.getenv("DRAMATIQ_QUEUE_PREFIX", "")

def get_queue_name(base_name: str) -> str:
    return f"{QUEUE_PREFIX}{base_name}" if QUEUE_PREFIX else base_name

db = DBConnection()

STALE_THRESHOLD_MINUTES = 30
MIN_USER_MESSAGES = 1
MAX_PROJECTS_PER_RUN = 50
DELAY_BETWEEN_PROJECTS_MS = 2000  # 2 second delay between tasks


@dramatiq.actor(queue_name=get_queue_name("default"))
async def categorize_project(project_id: str):
    """Categorize a project based on its thread messages."""
    logger.info(f"Categorizing project {project_id}")
    
    await db.initialize()
    client = await db.client
    
    try:
        # Get the thread for this project
        thread_result = await client.table('threads').select(
            'thread_id'
        ).eq('project_id', project_id).limit(1).execute()
        
        if not thread_result.data:
            logger.debug(f"No thread for project {project_id}")
            # Mark as categorized to avoid re-processing
            await client.table('projects').update({
                'last_categorized_at': datetime.now(timezone.utc).isoformat()
            }).eq('project_id', project_id).execute()
            return
        
        thread_id = thread_result.data[0]['thread_id']
        
        # Get messages (type = role, content is JSONB)
        messages_result = await client.table('messages').select(
            'type', 'content'
        ).eq('thread_id', thread_id).order('created_at').execute()
        
        messages = messages_result.data or []
        
        # Check minimum user messages (type='user' not role='user')
        user_count = sum(1 for m in messages if m.get('type') == 'user')
        if user_count < MIN_USER_MESSAGES:
            logger.debug(f"Project {project_id} has only {user_count} user messages")
            await client.table('projects').update({
                'last_categorized_at': datetime.now(timezone.utc).isoformat()
            }).eq('project_id', project_id).execute()
            return
        
        # Categorize
        categories = await categorize_from_messages(messages)
        if not categories:
            categories = ["Other"]
        
        # Update project
        await client.table('projects').update({
            'categories': categories,
            'last_categorized_at': datetime.now(timezone.utc).isoformat()
        }).eq('project_id', project_id).execute()
        
        logger.info(f"Categorized project {project_id}: {categories}")
        
    except Exception as e:
        logger.error(f"Categorization failed for project {project_id}: {e}")


@dramatiq.actor(queue_name=get_queue_name("default"))
async def process_stale_projects():
    """Find and categorize projects inactive for 30+ minutes."""
    logger.info("Processing stale projects for categorization")
    
    await db.initialize()
    client = await db.client
    
    try:
        stale_threshold = datetime.now(timezone.utc) - timedelta(minutes=STALE_THRESHOLD_MINUTES)
        
        # Find projects: inactive 30+ mins AND (never categorized OR has new activity)
        result = await client.rpc(
            'get_stale_projects_for_categorization',
            {
                'stale_threshold': stale_threshold.isoformat(),
                'max_count': MAX_PROJECTS_PER_RUN
            }
        ).execute()
        
        projects = result.data or []
        
        if not projects:
            logger.debug("No stale projects to categorize")
            return
        
        logger.info(f"Found {len(projects)} stale projects")
        
        for i, project in enumerate(projects):
            # Stagger task dispatch to avoid rate limits
            delay_ms = i * DELAY_BETWEEN_PROJECTS_MS
            categorize_project.send_with_options(
                args=(project['project_id'],),
                delay=delay_ms
            )
        
    except Exception as e:
        logger.error(f"Stale project processing failed: {e}")

