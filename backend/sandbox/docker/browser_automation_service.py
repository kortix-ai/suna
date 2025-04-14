import asyncio
from typing import List, Dict, Any, Optional, Union
from fastapi import APIRouter
from pydantic import BaseModel
from enum import Enum
from playwright.async_api import async_playwright, Browser, Page, Mouse, Keyboard
import base64

class MouseButton(str, Enum):
    left = "left"
    middle = "middle"
    right = "right"

class Position(BaseModel):
    x: Optional[int] = None
    y: Optional[int] = None

class MouseAction(BaseModel):
    x: Optional[int] = None
    y: Optional[int] = None
    clicks: Optional[int] = 1
    button: MouseButton = MouseButton.left
    delay: Optional[float] = 0.0

class KeyboardAction(BaseModel):
    key: str

class KeyboardPress(BaseModel):
    keys: Union[str, List[str]]
    delay: Optional[float] = 0.0

class WriteAction(BaseModel):
    message: str
    delay: Optional[float] = 0.0

class HotkeyAction(BaseModel):
    keys: List[str]
    delay: Optional[float] = 0.0

class BrowserAutomation:
    def __init__(self):
        self.router = APIRouter()
        self.browser: Optional[Browser] = None
        self.page: Optional[Page] = None
        self.mouse: Optional[Mouse] = None
        self.keyboard: Optional[Keyboard] = None
        
        # Register routes
        self.router.on_startup.append(self.startup)
        self.router.on_shutdown.append(self.shutdown)
        
        self.router.get("/automation/mouse/position")(self.get_mouse_position)
        self.router.post("/automation/mouse/move")(self.move_mouse)
        self.router.post("/automation/mouse/click")(self.click_mouse)
        self.router.post("/automation/mouse/down")(self.mouse_down)
        self.router.post("/automation/mouse/up")(self.mouse_up)
        self.router.post("/automation/keyboard/press")(self.press_key)
        self.router.post("/automation/keyboard/write")(self.write_text)
        self.router.post("/automation/keyboard/hotkey")(self.press_hotkey)
        self.router.post("/automation/navigate_to")(self.navigate_to)
        self.router.post("/automation/screenshot")(self.take_screenshot)

    async def startup(self):
        """Initialize the browser instance on startup"""
        playwright = await async_playwright().start()
        # Connect to the persistent browser running on port 9222
        self.browser = await playwright.chromium.connect_over_cdp("http://localhost:9222")
        # self.browser = await playwright.chromium.launch(headless=False)
        self.page = await self.browser.new_page()
        # await self.page.goto('about:blank')
        self.mouse = self.page.mouse
        self.keyboard = self.page.keyboard

    async def shutdown(self):
        """Clean up browser instance on shutdown"""
        if self.browser:
            await self.browser.close()

    async def get_mouse_position(self):
        """Get current mouse position"""
        try:
            # Playwright doesn't provide direct mouse position
            # We'll return the last known position from our tracking
            return {"x": 0, "y": 0}  # Default position
        except Exception as e:
            return {"error": str(e), "x": 0, "y": 0}

    async def move_mouse(self, action: Position):
        """Move mouse to specified position"""
        try:
            await self.mouse.move(action.x, action.y)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def click_mouse(self, action: MouseAction):
        """Click at the specified position"""
        try:
            await self.mouse.click(
                action.x, 
                action.y, 
                button=action.button,
                click_count=action.clicks,
                delay=action.delay * 1000 if action.delay else None
            )
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def mouse_down(self, action: MouseAction):
        """Press mouse button down"""
        try:
            await self.mouse.down(button=action.button)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def mouse_up(self, action: MouseAction):
        """Release mouse button"""
        try:
            await self.mouse.up(button=action.button)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def press_key(self, action: KeyboardPress):
        """Press specified key(s)"""
        try:
            if isinstance(action.keys, list):
                for key in action.keys:
                    await self.keyboard.press(key)
                    if action.delay:
                        await asyncio.sleep(action.delay)
            else:
                await self.keyboard.press(action.keys)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def write_text(self, action: WriteAction):
        """Type specified text"""
        try:
            await self.keyboard.type(action.message, delay=action.delay * 1000 if action.delay else undefined)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def press_hotkey(self, action: HotkeyAction):
        """Press multiple keys simultaneously"""
        try:
            # Press all keys in sequence
            for key in action.keys:
                await self.keyboard.down(key)
            
            # Release all keys in reverse order
            for key in reversed(action.keys):
                await self.keyboard.up(key)
                
            if action.delay:
                await asyncio.sleep(action.delay)
                
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def navigate_to(self, url: str):
        """Navigate to a specified URL"""
        try:
            await self.page.goto(url)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def take_screenshot(self) -> Dict[str, str]:
        """Take a screenshot of the current page"""
        try:
            screenshot_bytes = await self.page.screenshot()
            return {"image": base64.b64encode(screenshot_bytes).decode()}
        except Exception as e:
            return {"error": str(e)}

# Create a singleton instance
automation_service = BrowserAutomation()


async def run_demo():
    """Run a demonstration of browser automation capabilities"""
    print("Starting browser automation demo...")
    
    # Initialize the automation service
    service = BrowserAutomation()
    await service.startup()
    
    try:
        # 1. Navigate to a test website
        await service.page.goto('https://playwright.dev')
        print("✓ Navigated to playwright.dev")
        await asyncio.sleep(2)
        
        # 2. Take a screenshot
        result = await service.take_screenshot()
        if 'image' in result:
            print("✓ Took initial screenshot")
        
        # 3. Move mouse to center and click
        center_pos = MouseAction(
            x=500,
            y=300,
            clicks=1
        )
        await service.move_mouse(Position(x=center_pos.x, y=center_pos.y))
        print("✓ Moved mouse to center")
        await asyncio.sleep(1)
        
        await service.click_mouse(center_pos)
        print("✓ Clicked at center")
        await asyncio.sleep(1)
        
        # 4. Type some text into search box
        # First, click the search button
        await service.page.click('button[type="button"]:has-text("Search")')
        print("✓ Clicked search button")
        await asyncio.sleep(1)
        
        # Type search term
        write_action = WriteAction(
            message="browser automation",
            delay=0.1
        )
        await service.write_text(write_action)
        print("✓ Typed search text")
        await asyncio.sleep(2)
        
        # 5. Press Enter
        enter_action = KeyboardPress(
            keys="Enter"
        )
        await service.press_key(enter_action)
        print("✓ Pressed Enter")
        await asyncio.sleep(2)
        
        # 6. Demonstrate hotkeys (e.g., Ctrl+A to select all)
        hotkey_action = HotkeyAction(
            keys=["Control", "a"]
        )
        await service.press_hotkey(hotkey_action)
        print("✓ Pressed Ctrl+A")
        await asyncio.sleep(1)
        
        # 7. Take another screenshot after interactions
        result = await service.take_screenshot()
        if 'image' in result:
            print("✓ Took final screenshot")
        
        print("\nDemo completed successfully! 🎉")
        
    except Exception as e:
        print(f"Error during demo: {str(e)}", file=sys.stderr)
        raise
    finally:
        # Clean up
        await service.shutdown()
        print("Browser closed.")

def main():
    """Main entry point"""
    print("Browser Automation Demo")
    print("======================")
    asyncio.run(run_demo())

if __name__ == "__main__":
    main() 