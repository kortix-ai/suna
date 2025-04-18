import os

from daytona_sdk import Daytona, DaytonaConfig, CreateSandboxParams, Sandbox
from daytona_api_client.models.workspace_state import WorkspaceState
from dotenv import load_dotenv

from agentpress.tool import Tool
from utils.logger import logger
from utils.files_utils import clean_path

load_dotenv()

logger.debug("Initializing Daytona sandbox configuration")
config = DaytonaConfig(
    api_key=os.getenv("DAYTONA_API_KEY"),
    server_url=os.getenv("DAYTONA_SERVER_URL"),
    target=os.getenv("DAYTONA_TARGET")
)

if config.api_key:
    logger.debug("Daytona API key configured successfully")
else:
    logger.warning("No Daytona API key found in environment variables")

if config.server_url:
    logger.debug(f"Daytona server URL set to: {config.server_url}")
else:
    logger.warning("No Daytona server URL found in environment variables")

if config.target:
    logger.debug(f"Daytona target set to: {config.target}")
else:
    logger.warning("No Daytona target found in environment variables")

daytona = Daytona(config)
logger.debug("Daytona client initialized")

async def get_or_start_sandbox(sandbox_id: str):
    """Retrieve a sandbox by ID, check its state, and start it if needed."""
    
    logger.info(f"Getting or starting sandbox with ID: {sandbox_id}")
    
    try:
        sandbox = daytona.get_current_sandbox(sandbox_id)
        
        # Check if sandbox needs to be started
        if sandbox.instance.state == WorkspaceState.ARCHIVED or sandbox.instance.state == WorkspaceState.STOPPED:
            logger.info(f"Sandbox is in {sandbox.instance.state} state. Starting...")
            try:
                daytona.start(sandbox)
                # Wait a moment for the sandbox to initialize
                # sleep(5)
                # Refresh sandbox state after starting
                sandbox = daytona.get_current_sandbox(sandbox_id)
            except Exception as e:
                logger.error(f"Error starting sandbox: {e}")
                raise e
        
        logger.info(f"Sandbox {sandbox_id} is ready")
        return sandbox
        
    except Exception as e:
        logger.error(f"Error retrieving or starting sandbox: {str(e)}")
        raise e

def create_sandbox(password: str):
    """Create a new sandbox with all required services configured and running."""
    
    logger.info("Creating new Daytona sandbox environment")
    logger.debug("Configuring sandbox with browser-use image and environment variables")
    
    openai_api_key = os.getenv("OPENAI_API_KEY")
    if not openai_api_key:
        logger.warning("OPENAI_API_KEY not found in environment variables")
    else:
        logger.debug("OPENAI_API_KEY configured for sandbox")
    
    sandbox = daytona.create(CreateSandboxParams(
        image="adamcohenhillel/kortix-suna:0.0.13",
        public=True,
        env_vars={
            "CHROME_PERSISTENT_SESSION": "true",
            "RESOLUTION": "1920x1080x24",
            "RESOLUTION_WIDTH": "1920",
            "RESOLUTION_HEIGHT": "1080",
            "VNC_PASSWORD": password,
            "ANONYMIZED_TELEMETRY": "false",
            "CHROME_PATH": "",
            "CHROME_USER_DATA": "",
            "CHROME_DEBUGGING_PORT": "9222",
            "CHROME_DEBUGGING_HOST": "localhost",
            "CHROME_CDP": ""
        },
        ports=[
            7788,  # Gradio default port
            6080,  # noVNC web interface
            5900,  # VNC port
            5901,  # VNC port
            9222,  # Chrome remote debugging port
            8080   # HTTP website port
        ]
    ))
    logger.info(f"Sandbox created with ID: {sandbox.id}")
    
    # HTTP server is now started automatically by Docker
    
    logger.info(f"Sandbox environment successfully initialized")
    return sandbox


class SandboxToolsBase(Tool):
    """Tool for executing tasks in a Daytona sandbox with browser-use capabilities."""
    
    # Class variable to track if sandbox URLs have been printed
    _urls_printed = False
    
    def __init__(self, sandbox: Sandbox):
        super().__init__()
        self.sandbox = sandbox
        self.daytona = daytona
        self.workspace_path = "/workspace"

        self.sandbox_id = sandbox.id
        # logger.info(f"Initializing SandboxToolsBase with sandbox ID: {sandbox_id}")
        
        try:
            logger.debug(f"Retrieving sandbox with ID: {self.sandbox_id}")
            self.sandbox = self.daytona.get_current_sandbox(self.sandbox_id)
            # logger.info(f"Successfully retrieved sandbox: {self.sandbox.id}")
        except Exception as e:
            logger.error(f"Error retrieving sandbox: {str(e)}", exc_info=True)
            raise e

        # Get and log preview links
        vnc_url = self.sandbox.get_preview_link(6080)
        website_url = self.sandbox.get_preview_link(8080)
        
        # logger.info(f"Sandbox VNC URL: {vnc_url}")
        # logger.info(f"Sandbox Website URL: {website_url}")
        
        if not SandboxToolsBase._urls_printed:
            print("\033[95m***")
            print(vnc_url)
            print(website_url)
            print("***\033[0m")
            SandboxToolsBase._urls_printed = True

    def clean_path(self, path: str) -> str:
        cleaned_path = clean_path(path, self.workspace_path)
        logger.debug(f"Cleaned path: {path} -> {cleaned_path}")
        return cleaned_path
