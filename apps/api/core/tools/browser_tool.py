from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.agentpress.thread_manager import ThreadManager
from core.sandbox.tool_base import SandboxToolsBase
from core.utils.logger import logger
from core.utils.s3_upload_utils import upload_base64_image
import asyncio
import json
import base64
import io
import traceback
from PIL import Image
from core.utils.config import config

@tool_metadata(
    display_name="Browser",
    description="Interact with web pages using mouse and keyboard, take screenshots, and extract content",
    icon="Globe",
    color="bg-cyan-100 dark:bg-cyan-800/50",
    weight=60,
    visible=True,
    usage_guide="""
## Browser - Web page interaction and automation

Use a mouse and keyboard to interact with a web browser, and take screenshots. Full browser automation using natural language actions in a sandboxed environment.

### Available Tools
- **browser_navigate_to**: Navigate to any URL
- **browser_act**: Perform ANY action using natural language (click, type, scroll, etc.)
- **browser_extract_content**: Extract structured data from pages
- **browser_screenshot**: Capture current page state

### When to Use
- Interacting with websites that require clicks, forms, logins
- Extracting data from dynamic pages that require JavaScript
- Filling out forms or completing multi-step web flows
- Verifying website state or visual elements
- Any task requiring visual inspection of web content

### ⚠️ DIRECT URL/WEBSITE RESEARCH (IMPORTANT!)
When the user mentions a SPECIFIC website/URL to research (e.g. "create a slide deck for example.io"):
1. **USE BROWSER FIRST** - Navigate to the URL directly with browser_navigate_to
2. Browse through key pages (home, features, pricing, about) to understand the product
3. Use browser_extract_content to capture the information you need
4. THEN optionally use web_search for additional context, reviews, or news
- **NEVER** do a generic web search when the user wants info about a SPECIFIC website - browse it directly!

### ⚠️ INFORMATION REUSE (CRITICAL!)
- Once you've extracted content from a website using browser_extract_content, that is your **PRIMARY SOURCE OF TRUTH**
- DO NOT let web search results override or replace the information you extracted directly from the website
- Web search is only for ADDITIONAL context (reviews, news, competitor comparisons) - NOT to replace first-hand data
- When creating deliverables (presentations, reports, etc.), USE the content you extracted from the actual website
- If you already have information from a previous browser action in this conversation, CHECK IT before browsing again

### When NOT to Use
- Simple static content extraction → use scrape_webpage first (faster)
- API-based data retrieval → use appropriate API tools
- For GitHub URLs → prefer using the gh CLI via Bash instead

### browser_act - Natural Language Actions

Describe what you want to do in natural language:
- "click the login button"
- "fill in email with user@example.com"
- "scroll down"
- "select 'Option A' from the dropdown"
- "press Enter"

**Supports:**
- Clicking any element (buttons, links, images)
- Form filling (text, numbers, emails, passwords)
- Dropdown selection
- Scrolling (up, down, to element)
- Keyboard input (Enter, Tab, Escape)
- File uploads (use filePath parameter)
- iframes (use iframes parameter)

### Screenshot Validation

**IMPORTANT:** Every browser action returns a screenshot.
- Whenever you intend to click on an element, consult the screenshot to determine coordinates
- If a click failed to load, try adjusting your click location so the cursor tip falls on the element
- Make sure to click buttons, links, icons with the cursor tip in the center of the element
- Review screenshots after each action to verify expected results

### Usage Pattern

```
# Navigate to site
browser_navigate_to(url="https://example.com")

# Perform actions
browser_act(action="click the Sign In button")
browser_act(action="fill in username with john@email.com")
browser_act(action="fill in password with ***", variables={"password": "actual_pass"})
browser_act(action="click Submit")

# Extract data
browser_extract_content(instruction="get all product names and prices")
```

### Important Notes
- Screenshots auto-included with every action - use them to verify
- Use variables parameter for sensitive data (not logged to LLM providers)
- Include filePath for any file upload actions
- Browser is sandboxed - safe for any site
"""
)
class BrowserTool(SandboxToolsBase):
    """
    Browser Tool for browser automation using local Stagehand API.
    
    This tool provides browser automation capabilities using a local Stagehand API server,
    replacing the sandbox browser tool functionality.
    
    Only 4 core functions that can handle everything:
    - browser_navigate_to: Navigate to URLs
    - browser_act: Perform any action (click, type, scroll, dropdowns etc.)
    - browser_extract_content: Extract content from pages
    - browser_screenshot: Take screenshots
    """


    def __init__(self, project_id: str, thread_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.thread_id = thread_id
    
    def _validate_base64_image(self, base64_string: str, max_size_mb: int = 10) -> tuple[bool, str]:
        """
        Comprehensive validation of base64 image data.
        
        Args:
            base64_string (str): The base64 encoded image data
            max_size_mb (int): Maximum allowed image size in megabytes
            
        Returns:
            tuple[bool, str]: (is_valid, error_message)
        """
        try:
            # Check if data exists and has reasonable length
            if not base64_string or len(base64_string) < 10:
                return False, "Base64 string is empty or too short"
            
            # Remove data URL prefix if present (data:image/jpeg;base64,...)
            if base64_string.startswith('data:'):
                try:
                    base64_string = base64_string.split(',', 1)[1]
                except (IndexError, ValueError):
                    return False, "Invalid data URL format"
            
            # Check if string contains only valid base64 characters
            # Base64 alphabet: A-Z, a-z, 0-9, +, /, = (padding)
            import re
            if not re.match(r'^[A-Za-z0-9+/]*={0,2}$', base64_string):
                return False, "Invalid base64 characters detected"
            
            # Check if base64 string length is valid (must be multiple of 4)
            if len(base64_string) % 4 != 0:
                return False, "Invalid base64 string length"
            
            # Attempt to decode base64
            try:
                image_data = base64.b64decode(base64_string, validate=True)
            except Exception as e:
                return False, f"Base64 decoding failed: {str(e)}"
            
            # Check decoded data size
            if len(image_data) == 0:
                return False, "Decoded image data is empty"
            
            # Check if decoded data size exceeds limit
            max_size_bytes = max_size_mb * 1024 * 1024
            if len(image_data) > max_size_bytes:
                return False, f"Image size ({len(image_data)} bytes) exceeds limit ({max_size_bytes} bytes)"
            
            # Validate that decoded data is actually a valid image using PIL
            try:
                image_stream = io.BytesIO(image_data)
                with Image.open(image_stream) as img:
                    # Verify the image by attempting to load it
                    img.verify()
                    
                    # Check if image format is supported
                    supported_formats = {'JPEG', 'PNG', 'GIF', 'BMP', 'WEBP', 'TIFF'}
                    if img.format not in supported_formats:
                        return False, f"Unsupported image format: {img.format}"
                    
                    return True, "Image validation successful"
                    
            except Exception as e:
                return False, f"Image validation failed: {str(e)}"
                
        except Exception as e:
            return False, f"Image validation error: {str(e)}"
    
    async def _debug_sandbox_services(self) -> str:
        """Debug method to check what services are running in the sandbox"""
        try:
            await self._ensure_sandbox()
            
            # Check what processes are running
            ps_cmd = "ps aux | grep -E '(python|uvicorn|stagehand|node)' | grep -v grep"
            response = await self.sandbox.process.exec(ps_cmd, timeout=10)
            
            processes = response.result if response.exit_code == 0 else "Failed to get process list"
            
            # Check what ports are listening
            netstat_cmd = "netstat -tlnp 2>/dev/null | grep -E ':(8003|8004)' || ss -tlnp 2>/dev/null | grep -E ':(8003|8004)' || echo 'No netstat/ss available'"
            response2 = await self.sandbox.process.exec(netstat_cmd, timeout=10)
            
            ports = response2.result if response2.exit_code == 0 else "Failed to get port list"
            
            debug_info = f"""
            === Sandbox Services Debug Info ===
            Running processes:
            {processes}

            Listening ports:
            {ports}

            === End Debug Info ===
            """
            return debug_info
            
        except Exception as e:
            return f"Error getting debug info: {e}"

    async def _check_stagehand_api_health(self) -> bool:
        """Check if the Stagehand API server is running and accessible"""
        try:
            await self._ensure_sandbox()
            
            # Retry logic: The browser API server takes a few seconds to start
            # after the sandbox initializes. We'll retry with exponential backoff.
            max_retries = 5
            retry_delays = [1, 2, 3, 5, 5]  # seconds between retries
            
            for attempt in range(max_retries):
                # Simple health check curl command
                curl_cmd = "curl -s -X GET 'http://localhost:8004/api' -H 'Content-Type: application/json'"
                
                if attempt > 0:
                    logger.info(f"Retrying Stagehand API health check (attempt {attempt + 1}/{max_retries})...")
                
                response = await self.sandbox.process.exec(curl_cmd, timeout=10)
                
                if response.exit_code == 0:
                    try:
                        result = json.loads(response.result)
                        if result.get("status") == "healthy":
                            logger.info("✅ Stagehand API server is running and healthy")
                            return True
                        else:
                            # If the browser api is not healthy, we need to initialize it
                            logger.info("Stagehand API server responded but browser not initialized. Initializing...")
                            # Pass API key securely as environment variable instead of command line argument
                            env_vars = {"GEMINI_API_KEY": config.GEMINI_API_KEY}

                            response = await self.sandbox.process.exec(
                                'curl -s -X POST "http://localhost:8004/api/init" -H "Content-Type: application/json" -d "{\\"api_key\\": \\"$GEMINI_API_KEY\\"}"',
                                timeout=90,
                                env=env_vars
                            )
                            if response.exit_code == 0:
                                try:
                                    init_result = json.loads(response.result)
                                    if init_result.get("status") == "healthy":
                                        logger.info("✅ Stagehand API server initialized successfully")
                                        return True
                                    else:
                                        logger.warning(f"Stagehand API initialization failed: {init_result}")
                                        # Don't return False yet, might succeed on retry
                                except json.JSONDecodeError:
                                    logger.warning(f"Init endpoint returned invalid JSON: {response.result}")
                            else:
                                logger.warning(f"Stagehand API initialization request failed: {response.result}")
                    except json.JSONDecodeError:
                        logger.warning(f"Stagehand API server responded but with invalid JSON: {response.result}")
                elif response.exit_code == 7:
                    # Connection refused - server not ready yet
                    logger.debug(f"Browser API server not ready yet (connection refused)")
                else:
                    logger.debug(f"Health check failed with exit code {response.exit_code}")
                
                # Wait before retrying (except on last attempt)
                if attempt < max_retries - 1:
                    await asyncio.sleep(retry_delays[attempt])
            
            # All retries exhausted
            logger.error(f"Stagehand API server failed to start after {max_retries} attempts")
            return False
                
        except Exception as e:
            logger.error(f"Error checking Stagehand API health: {e}")
            return False

    async def _execute_stagehand_api(self, endpoint: str, params: dict = None, method: str = "POST") -> ToolResult:
        """Execute a Stagehand action through the sandbox API"""
        try:
            # Check if Gemini API key is configured
            if not config.GEMINI_API_KEY:
                return self.fail_response("Browser tool is not available. GEMINI_API_KEY is not configured.")
            
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            # Check if Stagehand API server is running
            stagehand_healthy = await self._check_stagehand_api_health()
            
            if not stagehand_healthy:
                error_msg = "Stagehand API server is not running. Please ensure the Stagehand API server is running. Error: {response}"
                
                # Add debug information
                debug_info = await self._debug_sandbox_services()
                error_msg += f"\n\nDebug information:\n{debug_info}"
                
                logger.error(error_msg)
                return self.fail_response(error_msg)
            
            
            # Build the curl command to call the local Stagehand API
            url = f"http://localhost:8004/api/{endpoint}"  # Fixed localhost as curl runs inside container
            
            if method == "GET" and params:
                query_params = "&".join([f"{k}={v}" for k, v in params.items()])
                url = f"{url}?{query_params}"
                curl_cmd = f"curl -s -X {method} '{url}' -H 'Content-Type: application/json'"
            else:
                curl_cmd = f"curl -s -X {method} '{url}' -H 'Content-Type: application/json'"
                if params:
                    json_data = json.dumps(params)
                    curl_cmd += f" -d '{json_data}'"
            
            # logger.debug(f"\033[95mExecuting curl command:\033[0m\n{curl_cmd}")
            
            response = await self.sandbox.process.exec(curl_cmd, timeout=30)  # Execute curl inside sandbox
            
            if response.exit_code == 0:
                try:
                    result = json.loads(response.result)
                    logger.debug(f"Stagehand API result: {result}")

                    logger.debug("Stagehand API request completed successfully")

                    if "screenshot_base64" in result:
                        try:
                            screenshot_data = result["screenshot_base64"]
                            is_valid, validation_message = self._validate_base64_image(screenshot_data)
                            
                            if is_valid:
                                logger.debug(f"Screenshot validation passed: {validation_message}")
                                image_url = await upload_base64_image(screenshot_data, "browser-screenshots")
                                result["image_url"] = image_url
                                logger.debug(f"Uploaded screenshot to {image_url}")
                            else:
                                logger.warning(f"Screenshot validation failed: {validation_message}")
                                result["image_validation_error"] = validation_message
                                
                            del result["screenshot_base64"]
                            
                        except Exception as e:
                            logger.error(f"Failed to process screenshot: {e}")
                            result["image_upload_error"] = str(e)
                    
                    result["input"] = params
                    added_message = await self.thread_manager.add_message(
                        thread_id=self.thread_id,
                        type="browser_state",
                        content=result,
                        is_llm_message=False
                    )

                    # Prepare clean response for agent (filter out internal metadata)
                    # Only include data that's useful for the agent's decision making
                    clean_result = {
                        "success": result.get("success", True),
                        "message": result.get("message", "Stagehand action completed successfully")
                    }

                    # Include only data that actually comes from browserApi.ts
                    if result.get("url"):
                        clean_result["url"] = result["url"]
                    if result.get("title"):
                        clean_result["title"] = result["title"]
                    if result.get("action"):
                        clean_result["action"] = result["action"]
                    if result.get("image_url"):  # This is screenshot_base64 converted to image_url
                        clean_result["image_url"] = result["image_url"]
                    
                    # Include any error context that's useful for the agent
                    if result.get("image_validation_error"):
                        clean_result["screenshot_issue"] = f"Screenshot processing issue: {result['image_validation_error']}"
                    if result.get("image_upload_error"):
                        clean_result["screenshot_issue"] = f"Screenshot upload issue: {result['image_upload_error']}"
                    # Convert message_id to string to ensure JSON serialization works
                    message_id = added_message.get("message_id")
                    clean_result["message_id"] = str(message_id) if message_id else None

                    if clean_result.get("success"):
                        return self.success_response(clean_result)
                    else:
                        # Handle error responses with helpful context  
                        error_msg = result.get("error", result.get("message", "Unknown error"))
                        clean_result["message"] = error_msg
                        return self.fail_response(clean_result)

                except json.JSONDecodeError as e:
                    logger.error(f"Failed to parse response JSON: {response.result} {e}")
                    return self.fail_response(f"Failed to parse response JSON: {response.result} {e}")
            else:
                # Check if it's a connection error (exit code 7)
                if response.exit_code == 7:
                    error_msg = f"Stagehand API server is not available on port 8004. Please ensure the Stagehand API server is running. Error: {response}"
                    logger.error(error_msg)
                    return self.fail_response(error_msg)
                else:
                    logger.error(f"Stagehand API request failed: {response}")
                    return self.fail_response(f"Stagehand API request failed: {response}")

        except Exception as e:
            logger.error(f"Error executing Stagehand action: {e}")
            logger.debug(traceback.format_exc())
            return self.fail_response(f"Error executing Stagehand action: {e}")

    # Core Functions Only
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_navigate_to",
            "description": "Navigate to a specific url. **🚨 PARAMETER NAMES**: Use EXACTLY this parameter name: `url` (REQUIRED).",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "**REQUIRED** - The URL to navigate to. Example: 'https://example.com'"
                    }
                },
                "required": ["url"],
                "additionalProperties": False
            }
        }
    })
    async def browser_navigate_to(self, url: str) -> ToolResult:
        """Navigate to a URL using Stagehand."""
        logger.debug(f"Browser navigating to: {url}")
        return await self._execute_stagehand_api("navigate", {"url": url})
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_act",
            "description": "Perform any browser action using natural language description. CRITICAL: This tool automatically provides a screenshot with every action. For data entry actions (filling forms, entering text, selecting options), you MUST review the provided screenshot to verify that displayed values exactly match what was intended. Report mismatches immediately. CRITICAL FILE UPLOAD RULE: ANY action that involves clicking, interacting with, or locating upload buttons, file inputs, resume upload sections, or any element that might trigger a choose file dialog MUST include the filePath parameter with filePath. This includes actions like 'click upload button', 'locate resume section', 'find file input' etc. Always err on the side of caution - if there's any possibility the action might lead to a file dialog, include filePath. This prevents accidental file dialog triggers without proper file handling. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `action` (REQUIRED), `variables` (optional), `iframes` (optional), `filePath` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "**REQUIRED** - The action to perform. Examples: 'click the login button', 'fill in the email field with %email%', 'scroll down to see more content', 'select option 2 from the dropdown', 'press Enter', 'go back', 'wait 5 seconds', 'click at coordinates 100,200', 'select United States from the country dropdown'"
                    },
                    "variables": {
                        "type": "object",
                        "description": "**OPTIONAL** - Variables to use in the action. Variables in the action string are referenced using %variable_name%. These variables are NOT shared with LLM providers for security. Default: {}.",
                        "additionalProperties": {"type": "string"},
                        "default": {}
                    },
                    "iframes": {
                        "type": "boolean",
                        "description": "**OPTIONAL** - Whether to include iframe content in the action. Set to true if the target element is inside an iframe. Default: true.",
                        "default": True
                    },
                    "filePath": {
                        "type": "string",
                        "description": "**OPTIONAL** - CRITICAL: REQUIRED for ANY action that might involve file uploads. This includes: clicking upload buttons, locating resume sections, finding file inputs, scrolling to upload areas, or any action that could potentially trigger a file dialog. Always include this parameter when dealing with upload-related elements to prevent accidental file dialog triggers. The tool will automatically handle the file upload after the action is performed."
                    }
                },
                "required": ["action"],
                "additionalProperties": False
            }
        }
    })
    async def browser_act(self, action: str, variables: dict = None, iframes: bool = False, filePath: dict = None) -> ToolResult:
        """Perform any browser action using Stagehand."""
        logger.debug(f"Browser acting: {action} (variables={'***' if variables else None}, iframes={iframes}), filePath={filePath}")
        params = {"action": action, "iframes": iframes, "variables": variables}
        if filePath:
            params["filePath"] = filePath
        return await self._execute_stagehand_api("act", params)
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_extract_content",
            "description": "Extract structured content from the current page using Stagehand. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `instruction` (REQUIRED), `iframes` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "instruction": {
                        "type": "string",
                        "description": "**REQUIRED** - What content to extract. Example: 'extract all product prices', 'get the main heading', 'extract apartment listings with address and price'"
                    },
                    "iframes": {
                        "type": "boolean",
                        "description": "**OPTIONAL** - Whether to include iframe content in the extraction. Set to true if the target content is inside an iframe. Default: true.",
                        "default": True
                    }
                },
                "required": ["instruction"],
                "additionalProperties": False
            }
        }
    })
    async def browser_extract_content(self, instruction: str, iframes: bool = False) -> ToolResult:
        """Extract structured content from the current page using Stagehand."""
        logger.debug(f"Browser extracting: {instruction} (iframes={iframes})")
        params = {"instruction": instruction, "iframes": iframes}
        return await self._execute_stagehand_api("extract", params)
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_screenshot",
            "description": "Take a screenshot of the current page. **🚨 PARAMETER NAMES**: Use EXACTLY this parameter name: `name` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "**OPTIONAL** - Name for the screenshot. Default: 'screenshot'.",
                        "default": "screenshot"
                    }
                },
                "required": [],
                "additionalProperties": False
            }
        }
    })
    async def browser_screenshot(self, name: str = "screenshot") -> ToolResult:
        """Take a screenshot using Stagehand."""
        logger.debug(f"Browser taking screenshot: {name}")
        return await self._execute_stagehand_api("screenshot", {"name": name})
