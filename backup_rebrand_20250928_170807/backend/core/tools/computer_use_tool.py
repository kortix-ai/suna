import os
import time
import base64
import aiohttp
import asyncio
import logging
from typing import Optional, Dict
import os

from core.agentpress.tool import Tool, ToolResult, openapi_schema, usage_example
from core.sandbox.tool_base import SandboxToolsBase
from daytona_sdk import AsyncSandbox

KEYBOARD_KEYS = [
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    'enter', 'esc', 'backspace', 'tab', 'space', 'delete',
    'ctrl', 'alt', 'shift', 'win',
    'up', 'down', 'left', 'right',
    'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
    'ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+z', 'ctrl+a', 'ctrl+s',
    'alt+tab', 'alt+f4', 'ctrl+alt+delete'
]

class ComputerUseTool(SandboxToolsBase):
    """Computer automation tool for controlling the sandbox browser and GUI."""
    
    def __init__(self, project_id: str, thread_manager):
        """Initialize automation tool with sandbox connection."""
        super().__init__(project_id, thread_manager)
        self.session = None
        self.mouse_x = 0  # Track current mouse position
        self.mouse_y = 0
        # API URL will be set when first needed
        self.api_base_url = None
        self._url_initialized = False
        logging.info(f"Initialized Computer Use Tool")
    
    async def _ensure_api_url(self):
        """Ensure API URL is initialized."""
        if not self._url_initialized:
            await self._ensure_sandbox()
            # Get automation service URL using port 8000
            preview_link = await self.sandbox.get_preview_link(8000)
            self.api_base_url = preview_link.url if hasattr(preview_link, 'url') else str(preview_link)
            self._url_initialized = True
            logging.info(f"Initialized Computer Use Tool with API URL: {self.api_base_url}")
    
    async def _get_session(self) -> aiohttp.ClientSession:
        """Get or create aiohttp session for API requests."""
        if self.session is None or self.session.closed:
            self.session = aiohttp.ClientSession()
        return self.session
    
    async def _api_request(self, method: str, endpoint: str, data: Optional[Dict] = None) -> Dict:
        """Send request to automation service API."""
        try:
            # Ensure API URL is set
            await self._ensure_api_url()
            
            session = await self._get_session()
            url = f"{self.api_base_url}/api{endpoint}"
            
            logging.debug(f"API request: {method} {url} {data}")
            
            if method.upper() == "GET":
                async with session.get(url) as response:
                    result = await response.json()
            else:  # POST
                async with session.post(url, json=data) as response:
                    result = await response.json()
            
            logging.debug(f"API response: {result}")
            return result
            
        except Exception as e:
            logging.error(f"API request failed: {str(e)}")
            return {"success": False, "error": str(e)}
    
    async def cleanup(self):
        """Clean up resources."""
        if self.session and not self.session.closed:
            await self.session.close()
            self.session = None
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "move_to",
            "description": "Move cursor to specified position",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {
                        "type": "number",
                        "description": "X coordinate"
                    },
                    "y": {
                        "type": "number",
                        "description": "Y coordinate"
                    }
                },
                "required": ["x", "y"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="move_to">
        <parameter name="x">100</parameter>
        <parameter name="y">200</parameter>
        </invoke>
        </function_calls>
        ''')
    async def move_to(self, x: float, y: float) -> ToolResult:
        """Move cursor to specified position."""
        try:
            x_int = int(round(float(x)))
            y_int = int(round(float(y)))
            
            result = await self._api_request("POST", "/automation/mouse/move", {
                "x": x_int,
                "y": y_int
            })
            
            if result.get("success", False):
                self.mouse_x = x_int
                self.mouse_y = y_int
                return ToolResult(success=True, output=f"Moved to ({x_int}, {y_int})")
            else:
                return ToolResult(success=False, output=f"Failed to move: {result.get('error', 'Unknown error')}")
                
        except Exception as e:
            return ToolResult(success=False, output=f"Failed to move: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "click",
            "description": "Click at current or specified position",
            "parameters": {
                "type": "object",
                "properties": {
                    "button": {
                        "type": "string",
                        "description": "Mouse button to click",
                        "enum": ["left", "right", "middle"],
                        "default": "left"
                    },
                    "x": {
                        "type": "number",
                        "description": "Optional X coordinate"
                    },
                    "y": {
                        "type": "number",
                        "description": "Optional Y coordinate"
                    },
                    "num_clicks": {
                        "type": "integer",
                        "description": "Number of clicks",
                        "enum": [1, 2, 3],
                        "default": 1
                    }
                }
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="click">
        <parameter name="x">100</parameter>
        <parameter name="y">200</parameter>
        <parameter name="button">left</parameter>
        <parameter name="num_clicks">1</parameter>
        </invoke>
        </function_calls>
        ''')
    async def click(self, x: Optional[float] = None, y: Optional[float] = None, 
                   button: str = "left", num_clicks: int = 1) -> ToolResult:
        """Click at current or specified position."""
        try:
            x_val = x if x is not None else self.mouse_x
            y_val = y if y is not None else self.mouse_y
            
            x_int = int(round(float(x_val)))
            y_int = int(round(float(y_val)))
            num_clicks = int(num_clicks)
            
            result = await self._api_request("POST", "/automation/mouse/click", {
                "x": x_int,
                "y": y_int,
                "clicks": num_clicks,
                "button": button.lower()
            })
            
            if result.get("success", False):
                self.mouse_x = x_int
                self.mouse_y = y_int
                return ToolResult(success=True, 
                                output=f"{num_clicks} {button} click(s) performed at ({x_int}, {y_int})")
            else:
                return ToolResult(success=False, output=f"Failed to click: {result.get('error', 'Unknown error')}")
        except Exception as e:
            return ToolResult(success=False, output=f"Failed to click: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "scroll",
            "description": "Scroll the mouse wheel at current position",
            "parameters": {
                "type": "object",
                "properties": {
                    "amount": {
                        "type": "integer",
                        "description": "Scroll amount (positive for up, negative for down)",
                        "minimum": -10,
                        "maximum": 10
                    }
                },
                "required": ["amount"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="scroll">
        <parameter name="amount">-3</parameter>
        </invoke>
        </function_calls>
        ''')
    async def scroll(self, amount: int) -> ToolResult:
        """
        Scroll the mouse wheel at current position.
        Positive values scroll up, negative values scroll down.
        """
        try:
            amount = int(float(amount))
            amount = max(-10, min(10, amount))
            
            result = await self._api_request("POST", "/automation/mouse/scroll", {
                "clicks": amount,
                "x": self.mouse_x,
                "y": self.mouse_y
            })
            
            if result.get("success", False):
                direction = "up" if amount > 0 else "down"
                steps = abs(amount)
                return ToolResult(success=True, 
                                output=f"Scrolled {direction} {steps} step(s) at position ({self.mouse_x}, {self.mouse_y})")
            else:
                return ToolResult(success=False, output=f"Failed to scroll: {result.get('error', 'Unknown error')}")
        except Exception as e:
            return ToolResult(success=False, output=f"Failed to scroll: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "typing",
            "description": "Type specified text",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Text to type"
                    }
                },
                "required": ["text"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="typing">
        <parameter name="text">Hello World!</parameter>
        </invoke>
        </function_calls>
        ''')
    async def typing(self, text: str) -> ToolResult:
        """Type specified text."""
        try:
            text = str(text)
            
            result = await self._api_request("POST", "/automation/keyboard/write", {
                "message": text,
                "interval": 0.01
            })
            
            if result.get("success", False):
                return ToolResult(success=True, output=f"Typed: {text}")
            else:
                return ToolResult(success=False, output=f"Failed to type: {result.get('error', 'Unknown error')}")
        except Exception as e:
            return ToolResult(success=False, output=f"Failed to type: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "press",
            "description": "Press and release a key",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "description": "Key to press",
                        "enum": KEYBOARD_KEYS
                    }
                },
                "required": ["key"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="press">
        <parameter name="key">enter</parameter>
        </invoke>
        </function_calls>
        ''')
    async def press(self, key: str) -> ToolResult:
        """Press and release a key."""
        try:
            key = str(key).lower()
            
            result = await self._api_request("POST", "/automation/keyboard/press", {
                "keys": key,
                "presses": 1
            })
            
            if result.get("success", False):
                return ToolResult(success=True, output=f"Pressed key: {key}")
            else:
                return ToolResult(success=False, output=f"Failed to press key: {result.get('error', 'Unknown error')}")
        except Exception as e:
            return ToolResult(success=False, output=f"Failed to press key: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "wait",
            "description": "Wait for specified duration",
            "parameters": {
                "type": "object",
                "properties": {
                    "duration": {
                        "type": "number",
                        "description": "Duration in seconds",
                        "default": 0.5
                    }
                }
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="wait">
        <parameter name="duration">1.5</parameter>
        </invoke>
        </function_calls>
        ''')
    async def wait(self, duration: float = 0.5) -> ToolResult:
        """Wait for specified duration."""
        try:
            duration = float(duration)
            duration = max(0, min(10, duration))
            await asyncio.sleep(duration)
            return ToolResult(success=True, output=f"Waited {duration} seconds")
        except Exception as e:
            return ToolResult(success=False, output=f"Failed to wait: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "mouse_down",
            "description": "Press a mouse button",
            "parameters": {
                "type": "object",
                "properties": {
                    "button": {
                        "type": "string",
                        "description": "Mouse button to press",
                        "enum": ["left", "right", "middle"],
                        "default": "left"
                    }
                }
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="mouse_down">
        <parameter name="button">left</parameter>
        </invoke>
        </function_calls>
        ''')
    async def mouse_down(self, button: str = "left", x: Optional[float] = None, y: Optional[float] = None) -> ToolResult:
        """Press a mouse button at current or specified position."""
        try:
            x_val = x if x is not None else self.mouse_x
            y_val = y if y is not None else self.mouse_y
            
            x_int = int(round(float(x_val)))
            y_int = int(round(float(y_val)))
            
            result = await self._api_request("POST", "/automation/mouse/down", {
                "x": x_int,
                "y": y_int,
                "button": button.lower()
            })
            
            if result.get("success", False):
                self.mouse_x = x_int
                self.mouse_y = y_int
                return ToolResult(success=True, output=f"{button} button pressed at ({x_int}, {y_int})")
            else:
                return ToolResult(success=False, output=f"Failed to press button: {result.get('error', 'Unknown error')}")
        except Exception as e:
            return ToolResult(success=False, output=f"Failed to press button: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "mouse_up",
            "description": "Release a mouse button",
            "parameters": {
                "type": "object",
                "properties": {
                    "button": {
                        "type": "string",
                        "description": "Mouse button to release",
                        "enum": ["left", "right", "middle"],
                        "default": "left"
                    }
                }
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="mouse_up">
        <parameter name="button">left</parameter>
        </invoke>
        </function_calls>
        ''')
    async def mouse_up(self, button: str = "left", x: Optional[float] = None, y: Optional[float] = None) -> ToolResult:
        """Release a mouse button at current or specified position."""
        try:
            x_val = x if x is not None else self.mouse_x
            y_val = y if y is not None else self.mouse_y
            
            x_int = int(round(float(x_val)))
            y_int = int(round(float(y_val)))
            
            result = await self._api_request("POST", "/automation/mouse/up", {
                "x": x_int,
                "y": y_int,
                "button": button.lower()
            })
            
            if result.get("success", False):
                self.mouse_x = x_int
                self.mouse_y = y_int
                return ToolResult(success=True, output=f"{button} button released at ({x_int}, {y_int})")
            else:
                return ToolResult(success=False, output=f"Failed to release button: {result.get('error', 'Unknown error')}")
        except Exception as e:
            return ToolResult(success=False, output=f"Failed to release button: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "drag_to",
            "description": "Drag cursor to specified position",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {
                        "type": "number",
                        "description": "Target X coordinate"
                    },
                    "y": {
                        "type": "number",
                        "description": "Target Y coordinate"
                    }
                },
                "required": ["x", "y"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="drag_to">
        <parameter name="x">500</parameter>
        <parameter name="y">50</parameter>
        </invoke>
        </function_calls>
        ''')
    async def drag_to(self, x: float, y: float) -> ToolResult:
        """Click and drag from current position to target position."""
        try:
            target_x = int(round(float(x)))
            target_y = int(round(float(y)))
            start_x = self.mouse_x
            start_y = self.mouse_y
            
            result = await self._api_request("POST", "/automation/mouse/drag", {
                "x": target_x,
                "y": target_y,
                "duration": 0.3,
                "button": "left"
            })
            
            if result.get("success", False):
                self.mouse_x = target_x
                self.mouse_y = target_y
                return ToolResult(success=True, 
                                output=f"Dragged from ({start_x}, {start_y}) to ({target_x}, {target_y})")
            else:
                return ToolResult(success=False, output=f"Failed to drag: {result.get('error', 'Unknown error')}")
        except Exception as e:
            return ToolResult(success=False, output=f"Failed to drag: {str(e)}")

    async def get_screenshot_base64(self) -> Optional[dict]:
        """Capture screen and return as base64 encoded image."""
        try:
            result = await self._api_request("POST", "/automation/screenshot")
            
            if "image" in result:
                base64_str = result["image"]
                timestamp = time.strftime("%Y%m%d_%H%M%S")
                
                # Save screenshot to file
                screenshots_dir = "screenshots"
                if not os.path.exists(screenshots_dir):
                    os.makedirs(screenshots_dir)
                
                timestamped_filename = os.path.join(screenshots_dir, f"screenshot_{timestamp}.png")
                latest_filename = "latest_screenshot.png"
                
                # Decode base64 string and save to file
                img_data = base64.b64decode(base64_str)
                with open(timestamped_filename, 'wb') as f:
                    f.write(img_data)
                
                # Save a copy as the latest screenshot
                with open(latest_filename, 'wb') as f:
                    f.write(img_data)
                
                return {
                    "content_type": "image/png",
                    "base64": base64_str,
                    "timestamp": timestamp,
                    "filename": timestamped_filename
                }
            else:
                return None
                
        except Exception as e:
            print(f"[Screenshot] Error during screenshot process: {str(e)}")
            return None

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "hotkey",
            "description": "Press a key combination",
            "parameters": {
                "type": "object",
                "properties": {
                    "keys": {
                        "type": "string",
                        "description": "Key combination to press",
                        "enum": KEYBOARD_KEYS
                    }
                },
                "required": ["keys"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="hotkey">
        <parameter name="keys">ctrl+a</parameter>
        </invoke>
        </function_calls>
        ''')    
    async def hotkey(self, keys: str) -> ToolResult:
        """Press a key combination."""
        try:
            keys = str(keys).lower().strip()
            key_sequence = keys.split('+')
            
            result = await self._api_request("POST", "/automation/keyboard/hotkey", {
                "keys": key_sequence,
                "interval": 0.01
            })
            
            if result.get("success", False):
                return ToolResult(success=True, output=f"Pressed key combination: {keys}")
            else:
                return ToolResult(success=False, output=f"Failed to press keys: {result.get('error', 'Unknown error')}")
        except Exception as e:
            return ToolResult(success=False, output=f"Failed to press keys: {str(e)}")

if __name__ == "__main__":
    print("This module should be imported, not run directly.") 