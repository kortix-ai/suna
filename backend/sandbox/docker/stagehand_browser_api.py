from fastapi import FastAPI, APIRouter, HTTPException, Body
from pydantic import BaseModel
from typing import Optional, Dict, Any
import asyncio
import json
import logging
import base64
import os
import traceback
from datetime import datetime
import random

# Import Stagehand
from stagehand import Stagehand, StagehandConfig

#######################################################
# Action model definitions
#######################################################

class NavigateAction(BaseModel):
    model_config = {"protected_namespaces": ()}
    url: str
    model_api_key: Optional[str] = None  # Add API key parameter

class ActAction(BaseModel):
    model_config = {"protected_namespaces": ()}
    action: str
    model_api_key: Optional[str] = None  # Add API key parameter

class ExtractAction(BaseModel):
    model_config = {"protected_namespaces": ()}
    goal: str
    model_api_key: Optional[str] = None  # Add API key parameter

class ScreenshotAction(BaseModel):
    model_config = {"protected_namespaces": ()}
    name: Optional[str] = "screenshot"
    model_api_key: Optional[str] = None  # Add API key parameter

class ObserveAction(BaseModel):
    model_config = {"protected_namespaces": ()}
    instruction: Optional[str] = "Find actions that can be performed on this page."
    return_action: bool = True
    iframes: bool = False
    model_api_key: Optional[str] = None  # Add API key parameter

#######################################################
# Browser Action Result Model
#######################################################

class BrowserActionResult(BaseModel):
    model_config = {"protected_namespaces": (), "arbitrary_types_allowed": True}
    success: bool = True
    message: str = ""
    error: str = ""
    
    # Extended state information
    url: Optional[str] = None
    title: Optional[str] = None
    content: Optional[str] = None
    screenshot_base64: Optional[str] = None
    
    # Additional metadata
    element_count: int = 0
    viewport_width: Optional[int] = None
    viewport_height: Optional[int] = None

#######################################################
# Stagehand Browser Automation Implementation 
#######################################################

class StagehandBrowserAutomation:
    def __init__(self):
        self.router = APIRouter()
        self.logger = logging.getLogger("stagehand_browser_automation")
        self.screenshot_dir = os.path.join(os.getcwd(), "screenshots")
        os.makedirs(self.screenshot_dir, exist_ok=True)
        
        # Stagehand session management
        self.stagehand: Optional[Stagehand] = None
        self.browser_initialized = False
        self._startup_called = False  # Prevent double initialization
        self.current_api_key: Optional[str] = None  # Store current API key
        
        # Core Stagehand endpoints
        self.router.post("/stagehand/navigate")(self.navigate)
        self.router.post("/stagehand/act")(self.act)
        self.router.post("/stagehand/extract")(self.extract)
        self.router.post("/stagehand/screenshot")(self.screenshot)
        self.router.post("/stagehand/observe")(self.observe)

    async def ensure_initialized(self, model_api_key: str):
        """Ensure Stagehand is initialized (simple browser_api pattern)"""
        if self.browser_initialized and self.current_api_key == model_api_key:
            # Already initialized with same key, trust the session (like browser_api)
            return
            
        # Need to initialize
        await self.startup_once(model_api_key)
    
    async def startup_once(self, model_api_key: Optional[str] = None):
        """Initialize Stagehand browser session ONCE (browser_api pattern)"""
        if self.browser_initialized:
            print("Stagehand already initialized, skipping...")
            return
            
        try:
            print("Starting Stagehand browser initialization...")
            self._startup_called = True
            
            # API key must be provided via request parameter
            if not model_api_key:
                print("ERROR: MODEL_API_KEY is required via request parameter")
                raise ValueError("MODEL_API_KEY is required via request parameter")
                
            print(f"Using API key: {model_api_key[:10]}...")
            self.current_api_key = model_api_key
            
            # Use same pattern as working browser_api (no X server dependencies)
            print("Creating StagehandConfig using browser_api pattern...")
            
            # Try browser launch strategies like browser_api does
            browser_configs = [
                # First attempt: non-headless (like browser_api)
                {
                    "headless": False,
                    "timeout": 60000,
                    "accept_downloads": True,
                    "downloads_path": "/workspace"
                },
                # Fallback: minimal options (like browser_api)
                {
                    "timeout": 90000,
                    "accept_downloads": True,
                    "downloads_path": "/workspace"
                }
            ]
            
            config = None
            last_error = None
            
            for i, browser_options in enumerate(browser_configs):
                try:
                    print(f"Trying browser config {i+1}/{len(browser_configs)}... ({'headless' if browser_options.get('headless') else 'non-headless'})")
                    config = StagehandConfig(
                        env="LOCAL",
                        model_name="anthropic/claude-3-5-sonnet-20241022",
                        model_api_key=self.current_api_key,
                        enable_caching=True,
                        dom_settle_timeout_ms=30000,
                        verbose=2,
                        local_browser_launch_options=browser_options,
                    )
                    
                    # Test the config by trying to create Stagehand instance
                    test_stagehand = Stagehand(config)
                    await test_stagehand.init()
                    
                    # If we get here, the config works
                    print(f"✅ Browser config {i+1} succeeded!")
                    await test_stagehand.close()  # Clean up test instance
                    break
                    
                except Exception as e:
                    last_error = e
                    error_str = str(e)
                    print(f"❌ Browser config {i+1} failed: {error_str}")
                    config = None  # Reset config for next iteration
                    continue
            
            if not config:
                raise RuntimeError(f"All browser configurations failed. Last error: {last_error}")
            
            # Initialize the actual Stagehand instance (config was already tested)
            print("Creating final Stagehand instance...")
            self.stagehand = Stagehand(config)
            print("Initializing final Stagehand...")
            await self.stagehand.init()
            
            # Verify browser context is configured for downloads
            try:
                if hasattr(self.stagehand, 'browser_context') and self.stagehand.browser_context:
                    await self.stagehand.browser_context.set_default_navigation_timeout(30000)
                    print("✅ Browser context configured - downloads will be saved to /workspace")
            except Exception as e:
                print(f"Warning: Could not configure browser context: {e}")
            
            # Test basic functionality and navigate to Google.com as default page
            print("Testing Stagehand functionality...")
            try:
                # Navigate to Google.com as the default page (like browser_api.py)
                # Use longer timeout for initial navigation like browser_api
                await self.stagehand.page.goto("https://www.google.com", wait_until="domcontentloaded", timeout=45000)
                # Wait for network idle with timeout like browser_api
                try:
                    await self.stagehand.page.wait_for_load_state("networkidle", timeout=15000)
                except Exception as wait_error:
                    print(f"Network idle timeout during initial navigation (continuing): {wait_error}")
                
                current_url = self.stagehand.page.url
                print(f"✅ Browser ready - navigated to: {current_url}")
            except Exception as test_error:
                print(f"⚠️ Browser test failed but continuing: {test_error}")
                # Don't fail initialization for test issues
            
            self.browser_initialized = True
            print("✅ Stagehand browser initialized successfully")
            
        except Exception as e:
            print(f"❌ Stagehand startup error: {str(e)}")
            traceback.print_exc()
            self._startup_called = False  # Reset flag on error
            self.browser_initialized = False
            raise RuntimeError(f"Stagehand initialization failed: {str(e)}")
            
    async def shutdown(self):
        """Clean up Stagehand browser session"""
        if self.stagehand:
            try:
                await self.stagehand.close()
                print("Stagehand browser closed successfully")
            except Exception as e:
                print(f"Error closing Stagehand: {e}")
                # Try to force cleanup
                try:
                    if hasattr(self.stagehand, 'browser_context') and self.stagehand.browser_context:
                        await self.stagehand.browser_context.close()
                    if hasattr(self.stagehand, 'browser') and self.stagehand.browser:
                        await self.stagehand.browser.close()
                except Exception as force_error:
                    print(f"Force cleanup also failed: {force_error}")
        
        # Reset state
        self.stagehand = None
        self.browser_initialized = False
        self._startup_called = False
        self.current_api_key = None
        print("Stagehand session state reset")

    async def execute_stagehand_action(self, action_type: str, params: Dict[str, Any]) -> BrowserActionResult:
        """
        Execute a Stagehand action and return the result.
        
        Args:
            action_type: Type of action (navigate, act, extract, screenshot)
            params: Parameters for the action (including optional model_api_key)
            
        Returns:
            BrowserActionResult with the result of the action
        """
        try:
            # Extract API key and reinitialize if needed
            model_api_key = params.get('model_api_key')
            if model_api_key and model_api_key != self.current_api_key:
                print(f"API key changed, reinitializing Stagehand...")
                await self.ensure_initialized(model_api_key)
            elif not self.browser_initialized:
                print("Stagehand not initialized, starting up...")
                await self.ensure_initialized(model_api_key)
            
            # Additional check for browser health before each action
            if self.stagehand:
                try:
                    # Quick health check - try to get current URL
                    await asyncio.wait_for(self.stagehand.page.url, timeout=5.0)
                except Exception as health_error:
                    print(f"Browser health check failed: {health_error}")
                    print("Reinitializing browser session...")
                    await self.ensure_initialized(model_api_key)
            
            if not self.stagehand:
                return BrowserActionResult(
                    success=False,
                    error="Stagehand not initialized"
                )
            
            # Execute the appropriate action with crash recovery
            try:
                if action_type == "navigate":
                    return await self._navigate_stagehand(params['url'])
                elif action_type == "act":
                    return await self._act_stagehand(params['action'])
                elif action_type == "extract":
                    return await self._extract_stagehand(params['goal'])
                elif action_type == "screenshot":
                    return await self._screenshot_stagehand(params.get('name', 'screenshot'))
                elif action_type == "observe":
                    return await self._observe_stagehand(
                        params.get('instruction', 'Find actions that can be performed on this page.'),
                        params.get('return_action', True),
                        params.get('iframes', False)
                    )
                else:
                    return BrowserActionResult(
                        success=False,
                        error=f"Unknown action type: {action_type}"
                    )
            except Exception as action_error:
                # Check if it's a page crash and try to recover
                if "Page crashed" in str(action_error) or "Target closed" in str(action_error):
                    print(f"Detected browser crash during {action_type}, attempting recovery...")
                    try:
                        # Reinitialize the browser
                        await self.ensure_initialized(model_api_key)
                        # Retry the action once
                        if action_type == "navigate":
                            return await self._navigate_stagehand(params['url'])
                        elif action_type == "screenshot":
                            return await self._screenshot_stagehand(params.get('name', 'screenshot'))
                        elif action_type == "observe":
                            return await self._observe_stagehand(
                                params.get('instruction', 'Find actions that can be performed on this page.'),
                                params.get('return_action', True),
                                params.get('iframes', False)
                            )
                        else:
                            # For act and extract, don't retry as they depend on page state
                            return BrowserActionResult(
                                success=False,
                                error=f"Browser crashed during {action_type}. Session has been recovered, please retry the action."
                            )
                    except Exception as recovery_error:
                        return BrowserActionResult(
                            success=False,
                            error=f"Browser crash recovery failed: {str(recovery_error)}"
                        )
                else:
                    # Re-raise non-crash related errors
                    raise action_error
                
        except Exception as e:
            print(f"Error executing Stagehand action: {str(e)}")
            traceback.print_exc()
            return BrowserActionResult(
                success=False,
                error=f"Stagehand action failed: {str(e)}"
            )

    async def _get_stagehand_state(self, action_name: str) -> tuple:
        """Get updated browser state after any action - like browser_api pattern"""
        try:
            # Wait a moment for any potential async processes to settle
            await asyncio.sleep(0.5)
            
            # Take screenshot (base64 encoded)
            screenshot_buffer = await self.stagehand.page.screenshot()
            screenshot_base64 = base64.b64encode(screenshot_buffer).decode('utf-8')
            
            # Get page info
            current_url = self.stagehand.page.url
            title = await self.stagehand.page.title()
            
            page_info = {
                'url': current_url,
                'title': title
            }
            
            print(f"Captured state for {action_name}: {current_url}")
            return screenshot_base64, page_info
            
        except Exception as e:
            print(f"Error capturing stagehand state: {e}")
            return "", {'url': '', 'title': ''}

    async def _navigate_stagehand(self, url: str) -> BrowserActionResult:
        """Navigate to a URL using Stagehand - using exact browser_api pattern"""
        try:
            print(f"Stagehand navigating to: {url}")
            
            # Use EXACT same pattern as browser_api with better timeout handling
            await self.stagehand.page.goto(url, wait_until="domcontentloaded")
            
            # Wait for network idle with timeout handling like browser_api
            try:
                await self.stagehand.page.wait_for_load_state("networkidle", timeout=10000)
            except Exception as wait_error:
                print(f"Network idle timeout during navigation (continuing): {wait_error}")
                # Continue even if networkidle times out
            
            # Get updated state after navigation (like browser_api)
            screenshot, page_info = await self._get_stagehand_state(f"navigate_to({url})")
            
            return BrowserActionResult(
                success=True,
                message=f"Navigated to {url}",
                url=page_info['url'],
                title=page_info['title'],
                screenshot_base64=screenshot,
                content=f"Successfully navigated to {url}"
            )
            
        except Exception as e:
            error_msg = str(e)
            print(f"Stagehand navigation error: {error_msg}")
            
            # Check if it's a page crash and suggest fallback
            if "Page crashed" in error_msg:
                error_msg += ". Browser page crashed - this may be due to browser configuration issues in the Docker environment. Consider using the regular browser_api on port 8003 instead."
            
            # Try to get some state info even after error (like browser_api)
            try:
                screenshot, page_info = await self._get_stagehand_state("navigate_error_recovery")
                return BrowserActionResult(
                    success=False,
                    message=error_msg,
                    url=page_info['url'],
                    title=page_info['title'],
                    screenshot_base64=screenshot,
                    error=f"Navigation failed: {error_msg}"
                )
            except:
                # Complete fallback
                return BrowserActionResult(
                    success=False,
                    error=f"Navigation failed: {error_msg}"
                )

    async def _act_stagehand(self, action: str) -> BrowserActionResult:
        """Execute an action using Stagehand"""
        try:
            print(f"Stagehand acting: {action}")
            # Use page.act() method with timeout
            result = await asyncio.wait_for(
                self.stagehand.page.act(action),
                timeout=30.0
            )
            
            # Get updated state after action (like browser_api)
            screenshot, page_info = await self._get_stagehand_state(f"act({action})")
            
            return BrowserActionResult(
                success=True,
                message=f"Successfully executed action: {action}",
                url=page_info['url'],
                title=page_info['title'],
                screenshot_base64=screenshot,
                content=f"Action '{action}' completed successfully. Result: {result}"
            )
            
        except asyncio.TimeoutError:
            error_msg = f"Action '{action}' timed out after 30 seconds"
            print(f"Stagehand action timeout: {error_msg}")
            return BrowserActionResult(
                success=False,
                error=error_msg
            )
        except Exception as e:
            error_msg = str(e)
            print(f"Stagehand action error: {error_msg}")
            
            # Check if it's a page crash
            if "Page crashed" in error_msg:
                error_msg += ". Browser page crashed during action execution."
            
            return BrowserActionResult(
                success=False,
                error=f"Action failed: {error_msg}"
            )

    async def _extract_stagehand(self, goal: str) -> BrowserActionResult:
        """Extract content using Stagehand"""
        try:
            print(f"Stagehand extracting: {goal}")
            # Use page.extract() method with timeout
            result = await asyncio.wait_for(
                self.stagehand.page.extract(goal),
                timeout=30.0
            )
            
            # Extract content properly from result
            extracted_content = ""
            if hasattr(result, 'extraction'):
                extracted_content = str(result.extraction)
            elif isinstance(result, dict):
                extracted_content = json.dumps(result, indent=2)
            else:
                extracted_content = str(result)
            
            # Get updated state after extraction (like browser_api)
            screenshot, page_info = await self._get_stagehand_state(f"extract({goal})")
            
            return BrowserActionResult(
                success=True,
                message=f"Successfully extracted content for: {goal}",
                url=page_info['url'],
                title=page_info['title'],
                screenshot_base64=screenshot,
                content=extracted_content
            )
            
        except asyncio.TimeoutError:
            error_msg = f"Extraction '{goal}' timed out after 30 seconds"
            print(f"Stagehand extraction timeout: {error_msg}")
            return BrowserActionResult(
                success=False,
                error=error_msg
            )
        except Exception as e:
            error_msg = str(e)
            print(f"Stagehand extraction error: {error_msg}")
            
            # Check if it's a page crash
            if "Page crashed" in error_msg:
                error_msg += ". Browser page crashed during content extraction."
            
            return BrowserActionResult(
                success=False,
                error=f"Extraction failed: {error_msg}"
            )
    
    async def _screenshot_stagehand(self, name: str) -> BrowserActionResult:
        """Take a screenshot using Stagehand"""
        try:
            print(f"Stagehand taking screenshot: {name}")
            # Use page.screenshot() method with timeout
            screenshot_bytes = await asyncio.wait_for(
                self.stagehand.page.screenshot(full_page=False, type='jpeg', quality=60, timeout=60000, scale='device'),
                timeout=60
            )
            
            # Convert to base64
            screenshot_base64 = base64.b64encode(screenshot_bytes).decode('utf-8')
            
            # Get current page info
            current_url = self.stagehand.page.url
            title = await self.stagehand.page.title()
            
            return BrowserActionResult(
                success=True,
                message=f"Successfully took screenshot: {name}",
                url=current_url,
                title=title,
                screenshot_base64=screenshot_base64
            )
            
        except asyncio.TimeoutError:
            error_msg = f"Screenshot '{name}' timed out after 15 seconds"
            print(f"Stagehand screenshot timeout: {error_msg}")
            return BrowserActionResult(
                success=False,
                error=error_msg
            )
        except Exception as e:
            error_msg = str(e)
            print(f"Stagehand screenshot error: {error_msg}")
            
            # Check if it's a page crash
            if "Page crashed" in error_msg:
                error_msg += ". Browser page crashed during screenshot."
            
            return BrowserActionResult(
                success=False,
                error=f"Screenshot failed: {error_msg}"
            )

    async def _observe_stagehand(self, instruction: str, return_action: bool = True, iframes: bool = False) -> BrowserActionResult:
        """Observe elements on the page using Stagehand"""
        try:
            print(f"Stagehand observing: {instruction} (return_action={return_action}, iframes={iframes})")
            
            # Create observe options dict based on parameters
            observe_options = {
                "instruction": instruction,
                "returnAction": return_action,
                "iframes": iframes
            }
            
            # Use page.observe() method with timeout
            observations = await asyncio.wait_for(
                self.stagehand.page.observe(**observe_options),
                timeout=30.0
            )
            
            # Format observations for response
            observation_content = []
            if observations:
                for i, obs in enumerate(observations, 1):
                    if hasattr(obs, 'model_dump'):
                        # If it's a Pydantic model, convert to dict
                        obs_dict = obs.model_dump()
                    elif isinstance(obs, dict):
                        obs_dict = obs
                    else:
                        # Convert to dict if possible
                        obs_dict = obs.__dict__ if hasattr(obs, '__dict__') else {"observation": str(obs)}
                    
                    observation_content.append(f"Observation {i}: {json.dumps(obs_dict, indent=2)}")
            
            formatted_content = "\n\n".join(observation_content) if observation_content else "No observations found"
            
            # Get updated state after observation
            screenshot, page_info = await self._get_stagehand_state(f"observe({instruction})")
            
            return BrowserActionResult(
                success=True,
                message=f"Successfully observed page elements for: {instruction}",
                url=page_info['url'],
                title=page_info['title'],
                screenshot_base64=screenshot,
                content=formatted_content,
                element_count=len(observations) if observations else 0
            )
            
        except asyncio.TimeoutError:
            error_msg = f"Observation '{instruction}' timed out after 30 seconds"
            print(f"Stagehand observation timeout: {error_msg}")
            return BrowserActionResult(
                success=False,
                error=error_msg
            )
        except Exception as e:
            error_msg = str(e)
            print(f"Stagehand observation error: {error_msg}")
            
            # Check if it's a page crash
            if "Page crashed" in error_msg:
                error_msg += ". Browser page crashed during observation."
            
            return BrowserActionResult(
                success=False,
                error=f"Observation failed: {error_msg}"
            )

    # FastAPI endpoint handlers
    async def navigate(self, action: NavigateAction = Body(...)):
        """Navigate to a URL"""
        return await self.execute_stagehand_action("navigate", action.dict())

    async def act(self, action: ActAction = Body(...)):
        """Execute an action"""
        return await self.execute_stagehand_action("act", action.dict())

    async def extract(self, action: ExtractAction = Body(...)):
        """Extract content"""
        return await self.execute_stagehand_action("extract", action.dict())

    async def screenshot(self, action: ScreenshotAction = Body(...)):
        """Take a screenshot"""
        return await self.execute_stagehand_action("screenshot", action.dict())

    async def observe(self, action: ObserveAction = Body(...)):
        """Observe page elements"""
        return await self.execute_stagehand_action("observe", action.dict())

# Create FastAPI app
api_app = FastAPI(title="Stagehand Browser API", version="1.0.0")

# Create browser automation instance
browser_automation = StagehandBrowserAutomation()

# Include router
api_app.include_router(browser_automation.router, prefix="/api")

# Lifespan management
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    # No startup during app initialization - wait for first request with API key
    print("Stagehand API starting up...")
    yield
    # Cleanup on shutdown
    print("Stagehand API shutting down...")
    try:
        await browser_automation.shutdown()
    except Exception as e:
        print(f"Error during shutdown: {e}")

api_app.router.lifespan_context = lifespan

# Health check endpoint
@api_app.get("/api")
async def health_check():
    return {"status": "healthy", "service": "stagehand_browser_api"}

# Test endpoint
@api_app.get("/api/test")
async def test_stagehand_api():
    return {
        "message": "Stagehand Browser API is running",
        "timestamp": datetime.now().isoformat(),
        "browser_initialized": browser_automation.browser_initialized
    }

# Main block to run the server
if __name__ == "__main__":
    import uvicorn
    print("Starting Stagehand Browser API server on port 8004...")
    uvicorn.run(api_app, host="0.0.0.0", port=8004) 