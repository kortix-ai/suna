from daytona_sdk import AsyncDaytona, DaytonaConfig, CreateSandboxFromImageParams, AsyncSandbox, SessionExecuteRequest, Resources, SandboxState
from dotenv import load_dotenv
from utils.logger import logger
from utils.config import config
from utils.config import Configuration

load_dotenv()

logger.debug("Initializing Daytona sandbox configuration")
daytona_config = DaytonaConfig(
    api_key=config.DAYTONA_API_KEY,
    api_url=config.DAYTONA_SERVER_URL,  # Use api_url instead of server_url (deprecated)
    target=config.DAYTONA_TARGET,
)

if daytona_config.api_key:
    logger.debug("Daytona API key configured successfully")
else:
    logger.warning("No Daytona API key found in environment variables")

if daytona_config.api_url:
    logger.debug(f"Daytona API URL set to: {daytona_config.api_url}")
else:
    logger.warning("No Daytona API URL found in environment variables")

if daytona_config.target:
    logger.debug(f"Daytona target set to: {daytona_config.target}")
else:
    logger.warning("No Daytona target found in environment variables")

daytona = AsyncDaytona(daytona_config)

async def get_or_start_sandbox(sandbox_id: str) -> AsyncSandbox:
    """Retrieve a sandbox by ID, check its state, and start it if needed."""
    
    logger.info(f"Getting or starting sandbox with ID: {sandbox_id}")

    try:
        sandbox = await daytona.get(sandbox_id)
        
        # Check if sandbox needs to be started
        if sandbox.state == SandboxState.ARCHIVED or sandbox.state == SandboxState.STOPPED:
            logger.info(f"Sandbox is in {sandbox.state} state. Starting...")
            try:
                await daytona.start(sandbox)
                # Wait a moment for the sandbox to initialize
                # sleep(5)
                # Refresh sandbox state after starting
                sandbox = await daytona.get(sandbox_id)
                
                # Start supervisord in a session when restarting
                await start_supervisord_session(sandbox)
            except Exception as e:
                logger.error(f"Error starting sandbox: {e}")
                raise e
        
        logger.info(f"Sandbox {sandbox_id} is ready")
        return sandbox
        
    except Exception as e:
        logger.error(f"Error retrieving or starting sandbox: {str(e)}")
        raise e

async def start_supervisord_session(sandbox: AsyncSandbox):
    """Start supervisord in a session."""
    session_id = "supervisord-session"
    try:
        logger.info(f"Creating session {session_id} for supervisord")
        await sandbox.process.create_session(session_id)
        
        # Execute supervisord command
        await sandbox.process.execute_session_command(session_id, SessionExecuteRequest(
            command="exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf",
            var_async=True
        ))
        logger.info(f"Supervisord started in session {session_id}")
    except Exception as e:
        logger.error(f"Error starting supervisord session: {str(e)}")
        raise e

async def create_sandbox(password: str, project_id: str = None) -> AsyncSandbox:
    """Create a new sandbox with all required services configured and running."""
    
    logger.debug("Creating new Daytona sandbox environment")
    logger.debug("Configuring sandbox with browser-use image and environment variables")
    
    labels = None
    if project_id:
        logger.debug(f"Using sandbox_id as label: {project_id}")
        labels = {'id': project_id}
        
    params = CreateSandboxFromImageParams(
        image=Configuration.SANDBOX_IMAGE_NAME,
        public=True,
        labels=labels,
        env_vars={
            "CHROME_PERSISTENT_SESSION": "true",
            "RESOLUTION": "1024x768x24",
            "RESOLUTION_WIDTH": "1024",
            "RESOLUTION_HEIGHT": "768",
            "VNC_PASSWORD": password,
            "ANONYMIZED_TELEMETRY": "false",
            "CHROME_PATH": "",
            "CHROME_USER_DATA": "",
            "CHROME_DEBUGGING_PORT": "9222",
            "CHROME_DEBUGGING_HOST": "localhost",
            "CHROME_CDP": ""
        },
        resources=Resources(
            cpu=2,
            memory=4,
            disk=5,
        ),
        auto_stop_interval=15,
        auto_archive_interval=24 * 60,
    )
    
    # Create the sandbox
    sandbox = await daytona.create(params)
    logger.debug(f"Sandbox created with ID: {sandbox.id}")
    
    # Start supervisord in a session for new sandbox
    await start_supervisord_session(sandbox)
    
    logger.debug(f"Sandbox environment successfully initialized")
    return sandbox

async def delete_sandbox(sandbox_id: str) -> bool:
    """Delete a sandbox by its ID."""
    logger.info(f"Deleting sandbox with ID: {sandbox_id}")

    try:
        # Get the sandbox
        sandbox = await daytona.get(sandbox_id)
        
        # Delete the sandbox
        await daytona.delete(sandbox)
        
        logger.info(f"Successfully deleted sandbox {sandbox_id}")
        return True
    except Exception as e:
        logger.error(f"Error deleting sandbox {sandbox_id}: {str(e)}")
        raise e
