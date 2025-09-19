import traceback
import json
import base64
import io
from PIL import Image

from core.agentpress.tool import ToolResult, openapi_schema, usage_example
from core.agentpress.thread_manager import ThreadManager
from core.sandbox.tool_base import SandboxToolsBase
from core.utils.logger import logger
from core.utils.s3_upload_utils import upload_base64_image


class SandboxBrowserTool(SandboxToolsBase):
    """Tool for executing tasks in a Daytona sandbox with browser-use capabilities."""
    
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
                    
                    # Re-open for dimension checks (verify() closes the image)
                    image_stream.seek(0)
                    with Image.open(image_stream) as img_check:
                        width, height = img_check.size
                        
                        # Check reasonable dimension limits
                        max_dimension = 8192  # 8K resolution limit
                        if width > max_dimension or height > max_dimension:
                            return False, f"Image dimensions ({width}x{height}) exceed limit ({max_dimension}x{max_dimension})"
                        
                        # Check minimum dimensions
                        if width < 1 or height < 1:
                            return False, f"Invalid image dimensions: {width}x{height}"
                        
                        logger.debug(f"Valid image detected: {img.format}, {width}x{height}, {len(image_data)} bytes")
                        
            except Exception as e:
                return False, f"Invalid image data: {str(e)}"
            
            return True, "Valid image"
            
        except Exception as e:
            logger.error(f"Unexpected error during base64 image validation: {e}")
            return False, f"Validation error: {str(e)}"

    async def _execute_browser_action(self, endpoint: str, params: dict = None, method: str = "POST") -> ToolResult:
        """Execute a browser automation action through the API
        
        Args:
            endpoint (str): The API endpoint to call
            params (dict, optional): Parameters to send. Defaults to None.
            method (str, optional): HTTP method to use. Defaults to "POST".
            
        Returns:
            ToolResult: Result of the execution
        """
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            # Build the curl command
            url = f"http://localhost:8003/api/automation/{endpoint}"
            
            if method == "GET" and params:
                query_params = "&".join([f"{k}={v}" for k, v in params.items()])
                url = f"{url}?{query_params}"
                curl_cmd = f"curl -s -X {method} '{url}' -H 'Content-Type: application/json'"
            else:
                curl_cmd = f"curl -s -X {method} '{url}' -H 'Content-Type: application/json'"
                if params:
                    json_data = json.dumps(params)
                    curl_cmd += f" -d '{json_data}'"
            
            logger.debug("\033[95mExecuting curl command:\033[0m")
            logger.debug(f"{curl_cmd}")
            
            response = await self.sandbox.process.exec(curl_cmd, timeout=30)
            
            if response.exit_code == 0:
                try:
                    result = json.loads(response.result)

                    if not "content" in result:
                        result["content"] = ""
                    
                    if not "role" in result:
                        result["role"] = "assistant"

                    logger.debug("Browser automation request completed successfully")

                    if "screenshot_base64" in result:
                        try:
                            # Comprehensive validation of the base64 image data
                            screenshot_data = result["screenshot_base64"]
                            is_valid, validation_message = self._validate_base64_image(screenshot_data)
                            
                            if is_valid:
                                logger.debug(f"Screenshot validation passed: {validation_message}")
                                image_url = await upload_base64_image(screenshot_data)
                                result["image_url"] = image_url
                                logger.debug(f"Uploaded screenshot to {image_url}")
                            else:
                                logger.warning(f"Screenshot validation failed: {validation_message}")
                                result["image_validation_error"] = validation_message
                                
                            # Remove base64 data from result to keep it clean
                            del result["screenshot_base64"]
                            
                        except Exception as e:
                            logger.error(f"Failed to process screenshot: {e}")
                            result["image_upload_error"] = str(e)

                    added_message = await self.thread_manager.add_message(
                        thread_id=self.thread_id,
                        type="browser_state",
                        content=result,
                        is_llm_message=False
                    )

                    success_response = {}

                    if result.get("success"):
                        success_response["success"] = result["success"]
                        success_response["message"] = result.get("message", "Browser action completed successfully")
                    else:
                        success_response["success"] = False
                        success_response["message"] = result.get("message", "Browser action failed")

                    if added_message and 'message_id' in added_message:
                        success_response['message_id'] = added_message['message_id']
                    if result.get("url"):
                        success_response["url"] = result["url"]
                    if result.get("title"):
                        success_response["title"] = result["title"]
                    if result.get("element_count"):
                        success_response["elements_found"] = result["element_count"]
                    if result.get("pixels_below"):
                        success_response["scrollable_content"] = result["pixels_below"] > 0
                    if result.get("ocr_text"):
                        success_response["ocr_text"] = result["ocr_text"]
                    if result.get("image_url"):
                        success_response["image_url"] = result["image_url"]

                    if success_response.get("success"):
                        return self.success_response(success_response)
                    else:
                        return self.fail_response(success_response)

                except json.JSONDecodeError as e:
                    logger.error(f"Failed to parse response JSON: {response.result} {e}")
                    return self.fail_response(f"Failed to parse response JSON: {response.result} {e}")
            else:
                logger.error(f"Browser automation request failed 2: {response}")
                return self.fail_response(f"Browser automation request failed 2: {response}")

        except Exception as e:
            logger.error(f"Error executing browser action: {e}")
            logger.debug(traceback.format_exc())
            return self.fail_response(f"Error executing browser action: {e}")


    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_navigate_to",
            "description": "Navigate to a specific url",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The url to navigate to"
                    }
                },
                "required": ["url"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="browser_navigate_to">
        <parameter name="url">https://example.com</parameter>
        </invoke>
        </function_calls>
        ''')
    async def browser_navigate_to(self, url: str) -> ToolResult:
        """Navigate to a specific url
        
        Args:
            url (str): The url to navigate to
            
        Returns:
            dict: Result of the execution
        """
        return await self._execute_browser_action("navigate_to", {"url": url})

    # @openapi_schema({
    #     "type": "function",
    #     "function": {
    #         "name": "browser_search_google",
    #         "description": "Search Google with the provided query",
    #         "parameters": {
    #             "type": "object",
    #             "properties": {
    #                 "query": {
    #                     "type": "string",
    #                     "description": "The search query to use"
    #                 }
    #             },
    #             "required": ["query"]
    #         }
    #     }
    # })
    # @xml_schema(
    #     tag_name="browser-search-google",
    #     mappings=[
    #         {"param_name": "query", "node_type": "content", "path": "."}
    #     ],
    #     example='''
    #     <browser-search-google>
    #     artificial intelligence news
    #     </browser-search-google>
    #     '''
    # )
    # async def browser_search_google(self, query: str) -> ToolResult:
    #     """Search Google with the provided query
        
    #     Args:
    #         query (str): The search query to use
            
    #     Returns:
    #         dict: Result of the execution
    #     """
    #     logger.debug(f"\033[95mSearching Google for: {query}\033[0m")
    #     return await self._execute_browser_action("search_google", {"query": query})

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_go_back",
            "description": "Navigate back in browser history",
            "parameters": {
                "type": "object",
                "properties": {}
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="browser_go_back">
        </invoke>
        </function_calls>
        ''')
    async def browser_go_back(self) -> ToolResult:
        """Navigate back in browser history
        
        Returns:
            dict: Result of the execution
        """
        logger.debug(f"\033[95mNavigating back in browser history\033[0m")
        return await self._execute_browser_action("go_back", {})

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_wait",
            "description": "Wait for the specified number of seconds",
            "parameters": {
                "type": "object",
                "properties": {
                    "seconds": {
                        "type": "integer",
                        "description": "Number of seconds to wait (default: 3)"
                    }
                }
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="browser_wait">
        <parameter name="seconds">5</parameter>
        </invoke>
        </function_calls>
        ''')
    async def browser_wait(self, seconds: int = 3) -> ToolResult:
        """Wait for the specified number of seconds
        
        Args:
            seconds (int, optional): Number of seconds to wait. Defaults to 3.
            
        Returns:
            dict: Result of the execution
        """
        logger.debug(f"\033[95mWaiting for {seconds} seconds\033[0m")
        return await self._execute_browser_action("wait", {"seconds": seconds})

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_click_element",
            "description": "Click on an element by index",
            "parameters": {
                "type": "object",
                "properties": {
                    "index": {
                        "type": "integer",
                        "description": "The index of the element to click"
                    }
                },
                "required": ["index"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="browser_click_element">
        <parameter name="index">2</parameter>
        </invoke>
        </function_calls>
        ''')
    async def browser_click_element(self, index: int) -> ToolResult:
        """Click on an element by index
        
        Args:
            index (int): The index of the element to click
            
        Returns:
            dict: Result of the execution
        """
        logger.debug(f"\033[95mClicking element with index: {index}\033[0m")
        return await self._execute_browser_action("click_element", {"index": index})

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_input_text",
            "description": "Input text into an element",
            "parameters": {
                "type": "object",
                "properties": {
                    "index": {
                        "type": "integer",
                        "description": "The index of the element to input text into"
                    },
                    "text": {
                        "type": "string",
                        "description": "The text to input"
                    }
                },
                "required": ["index", "text"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="browser_input_text">
        <parameter name="index">2</parameter>
        <parameter name="text">Hello, world!</parameter>
        </invoke>
        </function_calls>
        ''')
    async def browser_input_text(self, index: int, text: str) -> ToolResult:
        """Input text into an element
        
        Args:
            index (int): The index of the element to input text into
            text (str): The text to input
            
        Returns:
            dict: Result of the execution
        """
        logger.debug(f"\033[95mInputting text into element {index}: {text}\033[0m")
        return await self._execute_browser_action("input_text", {"index": index, "text": text})

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_send_keys",
            "description": "Send keyboard keys such as Enter, Escape, or keyboard shortcuts",
            "parameters": {
                "type": "object",
                "properties": {
                    "keys": {
                        "type": "string",
                        "description": "The keys to send (e.g., 'Enter', 'Escape', 'Control+a')"
                    }
                },
                "required": ["keys"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="browser_send_keys">
        <parameter name="keys">Enter</parameter>
        </invoke>
        </function_calls>
        ''')
    async def browser_send_keys(self, keys: str) -> ToolResult:
        """Send keyboard keys
        
        Args:
            keys (str): The keys to send (e.g., 'Enter', 'Escape', 'Control+a')
            
        Returns:
            dict: Result of the execution
        """
        logger.debug(f"\033[95mSending keys: {keys}\033[0m")
        return await self._execute_browser_action("send_keys", {"keys": keys})

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_switch_tab",
            "description": "Switch to a different browser tab",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {
                        "type": "integer",
                        "description": "The ID of the tab to switch to"
                    }
                },
                "required": ["page_id"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="browser_switch_tab">
        <parameter name="page_id">1</parameter>
        </invoke>
        </function_calls>
        ''')
    async def browser_switch_tab(self, page_id: int) -> ToolResult:
        """Switch to a different browser tab
        
        Args:
            page_id (int): The ID of the tab to switch to
            
        Returns:
            dict: Result of the execution
        """
        logger.debug(f"\033[95mSwitching to tab: {page_id}\033[0m")
        return await self._execute_browser_action("switch_tab", {"page_id": page_id})

    # @openapi_schema({
    #     "type": "function",
    #     "function": {
    #         "name": "browser_open_tab",
    #         "description": "Open a new browser tab with the specified URL",
    #         "parameters": {
    #             "type": "object",
    #             "properties": {
    #                 "url": {
    #                     "type": "string",
    #                     "description": "The URL to open in the new tab"
    #                 }
    #             },
    #             "required": ["url"]
    #         }
    #     }
    # })
    # @xml_schema(
    #     tag_name="browser-open-tab",
    #     mappings=[
    #         {"param_name": "url", "node_type": "content", "path": "."}
    #     ],
    #     example='''
    #     <browser-open-tab>
    #     https://example.com
    #     </browser-open-tab>
    #     '''
    # )
    # async def browser_open_tab(self, url: str) -> ToolResult:
    #     """Open a new browser tab with the specified URL
        
    #     Args:
    #         url (str): The URL to open in the new tab
            
    #     Returns:
    #         dict: Result of the execution
    #     """
    #     logger.debug(f"\033[95mOpening new tab with URL: {url}\033[0m")
    #     return await self._execute_browser_action("open_tab", {"url": url})

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_close_tab",
            "description": "Close a browser tab",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {
                        "type": "integer",
                        "description": "The ID of the tab to close"
                    }
                },
                "required": ["page_id"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="browser_close_tab">
        <parameter name="page_id">1</parameter>
        </invoke>
        </function_calls>
        ''')
    async def browser_close_tab(self, page_id: int) -> ToolResult:
        """Close a browser tab
        
        Args:
            page_id (int): The ID of the tab to close
            
        Returns:
            dict: Result of the execution
        """
        logger.debug(f"\033[95mClosing tab: {page_id}\033[0m")
        return await self._execute_browser_action("close_tab", {"page_id": page_id})

    # @openapi_schema({
    #     "type": "function",
    #     "function": {
    #         "name": "browser_extract_content",
    #         "description": "Extract content from the current page based on the provided goal",
    #         "parameters": {
    #             "type": "object",
    #             "properties": {
    #                 "goal": {
    #                     "type": "string",
    #                     "description": "The extraction goal (e.g., 'extract all links', 'find product information')"
    #                 }
    #             },
    #             "required": ["goal"]
    #         }
    #     }
    # })
    # @xml_schema(
    #     tag_name="browser-extract-content",
    #     mappings=[
    #         {"param_name": "goal", "node_type": "content", "path": "."}
    #     ],
    #     example='''
    #     <browser-extract-content>
    #     Extract all links on the page
    #     </browser-extract-content>
    #     '''
    # )
    # async def browser_extract_content(self, goal: str) -> ToolResult:
    #     """Extract content from the current page based on the provided goal
        
    #     Args:
    #         goal (str): The extraction goal
            
    #     Returns:
    #         dict: Result of the execution
    #     """
    #     logger.debug(f"\033[95mExtracting content with goal: {goal}\033[0m")
    #     result = await self._execute_browser_action("extract_content", {"goal": goal})
        
    #     # Format content for better readability
    #     if result.get("success"):
    #         logger.debug(f"\033[92mContent extraction successful\033[0m")
    #         content = result.data.get("content", "")
    #         url = result.data.get("url", "")
    #         title = result.data.get("title", "")
            
    #         if content:
    #             content_preview = content[:200] + "..." if len(content) > 200 else content
    #             logger.debug(f"\033[95mExtracted content from {title} ({url}):\033[0m")
    #             logger.debug(f"\033[96m{content_preview}\033[0m")
    #             logger.debug(f"\033[95mTotal content length: {len(content)} characters\033[0m")
    #         else:
    #             logger.debug(f"\033[93mNo content extracted from {url}\033[0m")
    #     else:
    #         logger.debug(f"\033[91mFailed to extract content: {result.data.get('error', 'Unknown error')}\033[0m")
        
    #     return result

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_scroll_down",
            "description": "Scroll down the page",
            "parameters": {
                "type": "object",
                "properties": {
                    "amount": {
                        "type": "integer",
                        "description": "Pixel amount to scroll (if not specified, scrolls one page)"
                    }
                }
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="browser_scroll_down">
        <parameter name="amount">500</parameter>
        </invoke>
        </function_calls>
        ''')
    async def browser_scroll_down(self, amount: int = None) -> ToolResult:
        """Scroll down the page
        
        Args:
            amount (int, optional): Pixel amount to scroll. If None, scrolls one page.
            
        Returns:
            dict: Result of the execution
        """
        params = {}
        if amount is not None:
            params["amount"] = amount
            logger.debug(f"\033[95mScrolling down by {amount} pixels\033[0m")
        else:
            logger.debug(f"\033[95mScrolling down one page\033[0m")
        
        return await self._execute_browser_action("scroll_down", params)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_scroll_up",
            "description": "Scroll up the page",
            "parameters": {
                "type": "object",
                "properties": {
                    "amount": {
                        "type": "integer",
                        "description": "Pixel amount to scroll (if not specified, scrolls one page)"
                    }
                }
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="browser_scroll_up">
        <parameter name="amount">500</parameter>
        </invoke>
        </function_calls>
        ''')
    async def browser_scroll_up(self, amount: int = None) -> ToolResult:
        """Scroll up the page
        
        Args:
            amount (int, optional): Pixel amount to scroll. If None, scrolls one page.
            
        Returns:
            dict: Result of the execution
        """
        params = {}
        if amount is not None:
            params["amount"] = amount
            logger.debug(f"\033[95mScrolling up by {amount} pixels\033[0m")
        else:
            logger.debug(f"\033[95mScrolling up one page\033[0m")
        
        return await self._execute_browser_action("scroll_up", params)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_scroll_to_text",
            "description": "Scroll to specific text on the page",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "The text to scroll to"
                    }
                },
                "required": ["text"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="browser_scroll_to_text">
        <parameter name="text">Contact Us</parameter>
        </invoke>
        </function_calls>
        ''')
    async def browser_scroll_to_text(self, text: str) -> ToolResult:
        """Scroll to specific text on the page
        
        Args:
            text (str): The text to scroll to
            
        Returns:
            dict: Result of the execution
        """
        logger.debug(f"\033[95mScrolling to text: {text}\033[0m")
        return await self._execute_browser_action("scroll_to_text", {"text": text})

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_get_dropdown_options",
            "description": "Get all options from a dropdown element",
            "parameters": {
                "type": "object",
                "properties": {
                    "index": {
                        "type": "integer",
                        "description": "The index of the dropdown element"
                    }
                },
                "required": ["index"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="browser_get_dropdown_options">
        <parameter name="index">2</parameter>
        </invoke>
        </function_calls>
        ''')
    async def browser_get_dropdown_options(self, index: int) -> ToolResult:
        """Get all options from a dropdown element
        
        Args:
            index (int): The index of the dropdown element
            
        Returns:
            dict: Result of the execution with the dropdown options
        """
        logger.debug(f"\033[95mGetting options from dropdown with index: {index}\033[0m")
        return await self._execute_browser_action("get_dropdown_options", {"index": index})

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_select_dropdown_option",
            "description": "Select an option from a dropdown by text",
            "parameters": {
                "type": "object",
                "properties": {
                    "index": {
                        "type": "integer",
                        "description": "The index of the dropdown element"
                    },
                    "text": {
                        "type": "string",
                        "description": "The text of the option to select"
                    }
                },
                "required": ["index", "text"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="browser_select_dropdown_option">
        <parameter name="index">2</parameter>
        <parameter name="text">Option 1</parameter>
        </invoke>
        </function_calls>
        ''')
    async def browser_select_dropdown_option(self, index: int, text: str) -> ToolResult:
        """Select an option from a dropdown by text
        
        Args:
            index (int): The index of the dropdown element
            text (str): The text of the option to select
            
        Returns:
            dict: Result of the execution
        """
        logger.debug(f"\033[95mSelecting option '{text}' from dropdown with index: {index}\033[0m")
        return await self._execute_browser_action("select_dropdown_option", {"index": index, "text": text})

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_drag_drop",
            "description": "Perform drag and drop operation between elements or coordinates",
            "parameters": {
                "type": "object",
                "properties": {
                    "element_source": {
                        "type": "string",
                        "description": "The source element selector"
                    },
                    "element_target": {
                        "type": "string",
                        "description": "The target element selector"
                    },
                    "coord_source_x": {
                        "type": "integer",
                        "description": "The source X coordinate"
                    },
                    "coord_source_y": {
                        "type": "integer",
                        "description": "The source Y coordinate"
                    },
                    "coord_target_x": {
                        "type": "integer",
                        "description": "The target X coordinate"
                    },
                    "coord_target_y": {
                        "type": "integer",
                        "description": "The target Y coordinate"
                    }
                }
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="browser_drag_drop">
        <parameter name="element_source">#draggable</parameter>
        <parameter name="element_target">#droppable</parameter>
        </invoke>
        </function_calls>
        ''')
    async def browser_drag_drop(self, element_source: str = None, element_target: str = None, 
                               coord_source_x: int = None, coord_source_y: int = None,
                               coord_target_x: int = None, coord_target_y: int = None) -> ToolResult:
        """Perform drag and drop operation between elements or coordinates
        
        Args:
            element_source (str, optional): The source element selector
            element_target (str, optional): The target element selector
            coord_source_x (int, optional): The source X coordinate
            coord_source_y (int, optional): The source Y coordinate
            coord_target_x (int, optional): The target X coordinate
            coord_target_y (int, optional): The target Y coordinate
            
        Returns:
            dict: Result of the execution
        """
        params = {}
        
        if element_source and element_target:
            params["element_source"] = element_source
            params["element_target"] = element_target
            logger.debug(f"\033[95mDragging from element '{element_source}' to '{element_target}'\033[0m")
        elif all(coord is not None for coord in [coord_source_x, coord_source_y, coord_target_x, coord_target_y]):
            params["coord_source_x"] = coord_source_x
            params["coord_source_y"] = coord_source_y
            params["coord_target_x"] = coord_target_x
            params["coord_target_y"] = coord_target_y
            logger.debug(f"\033[95mDragging from coordinates ({coord_source_x}, {coord_source_y}) to ({coord_target_x}, {coord_target_y})\033[0m")
        else:
            return self.fail_response("Must provide either element selectors or coordinates for drag and drop")
        
        return await self._execute_browser_action("drag_drop", params)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "browser_click_coordinates",
            "description": "Click at specific X,Y coordinates on the page",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {
                        "type": "integer",
                        "description": "The X coordinate to click"
                    },
                    "y": {
                        "type": "integer",
                        "description": "The Y coordinate to click"
                    }
                },
                "required": ["x", "y"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="browser_click_coordinates">
        <parameter name="x">100</parameter>
        <parameter name="y">200</parameter>
        </invoke>
        </function_calls>
        ''')
    async def browser_click_coordinates(self, x: int, y: int) -> ToolResult:
        """Click at specific X,Y coordinates on the page
        
        Args:
            x (int): The X coordinate to click
            y (int): The Y coordinate to click
            
        Returns:
            dict: Result of the execution
        """
        logger.debug(f"\033[95mClicking at coordinates: ({x}, {y})\033[0m")
        return await self._execute_browser_action("click_coordinates", {"x": x, "y": y})