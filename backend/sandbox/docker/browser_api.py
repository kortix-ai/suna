from fastapi import FastAPI, APIRouter, HTTPException, Body
from playwright.async_api import async_playwright, Browser, Page, ElementHandle
from pydantic import BaseModel
from typing import Optional, List, Dict, Any, Union
import asyncio
import json
import logging
import re

# Action model definitions
class Position(BaseModel):
    x: int
    y: int

class ClickElementAction(BaseModel):
    index: int

class GoToUrlAction(BaseModel):
    url: str

class InputTextAction(BaseModel):
    index: int
    text: str

class ScrollAction(BaseModel):
    amount: Optional[int] = None

class SendKeysAction(BaseModel):
    keys: str

class SearchGoogleAction(BaseModel):
    query: str

class SwitchTabAction(BaseModel):
    page_id: int

class OpenTabAction(BaseModel):
    url: str

class CloseTabAction(BaseModel):
    page_id: int

class NoParamsAction(BaseModel):
    pass

class DragDropAction(BaseModel):
    element_source: Optional[str] = None
    element_target: Optional[str] = None
    element_source_offset: Optional[Position] = None
    element_target_offset: Optional[Position] = None
    coord_source_x: Optional[int] = None
    coord_source_y: Optional[int] = None
    coord_target_x: Optional[int] = None
    coord_target_y: Optional[int] = None
    steps: Optional[int] = 10
    delay_ms: Optional[int] = 5

class DoneAction(BaseModel):
    success: bool = True
    text: str = ""

class BrowserAutomation:
    def __init__(self):
        self.router = APIRouter()
        self.browser: Browser = None
        self.pages: List[Page] = []
        self.current_page_index: int = 0
        self.logger = logging.getLogger("browser_automation")
        
        # Register routes
        self.router.on_startup.append(self.startup)
        self.router.on_shutdown.append(self.shutdown)
        
        # Basic navigation
        self.router.post("/automation/navigate_to")(self.navigate_to)
        self.router.post("/automation/search_google")(self.search_google)
        self.router.post("/automation/go_back")(self.go_back)
        self.router.post("/automation/wait")(self.wait)
        
        # Element interaction
        self.router.post("/automation/click_element")(self.click_element)
        self.router.post("/automation/input_text")(self.input_text)
        self.router.post("/automation/send_keys")(self.send_keys)
        
        # Tab management
        self.router.post("/automation/switch_tab")(self.switch_tab)
        self.router.post("/automation/open_tab")(self.open_tab)
        self.router.post("/automation/close_tab")(self.close_tab)
        
        # Content actions
        self.router.post("/automation/extract_content")(self.extract_content)
        self.router.post("/automation/save_pdf")(self.save_pdf)
        
        # Scroll actions
        self.router.post("/automation/scroll_down")(self.scroll_down)
        self.router.post("/automation/scroll_up")(self.scroll_up)
        self.router.post("/automation/scroll_to_text")(self.scroll_to_text)
        
        # Dropdown actions
        self.router.post("/automation/get_dropdown_options")(self.get_dropdown_options)
        self.router.post("/automation/select_dropdown_option")(self.select_dropdown_option)
        
        # Drag and drop
        self.router.post("/automation/drag_drop")(self.drag_drop)

    async def startup(self):
        """Initialize the browser instance on startup"""
        playwright = await async_playwright().start()
        # self.browser = await playwright.chromium.connect_over_cdp("http://localhost:9222")
        self.browser = await playwright.chromium.launch(headless=False)
        page = await self.browser.new_page()
        self.pages.append(page)
        self.current_page_index = 0

    async def shutdown(self):
        """Clean up browser instance on shutdown"""
        if self.browser:
            await self.browser.close()
    
    async def get_current_page(self) -> Page:
        """Get the current active page"""
        if not self.pages:
            raise HTTPException(status_code=500, detail="No browser pages available")
        return self.pages[self.current_page_index]
    
    async def get_selector_map(self) -> Dict[int, Any]:
        """Get a map of selectable elements on the page"""
        page = await self.get_current_page()
        # This is a simplified implementation - a real one would need to
        # identify clickable elements and create a mapping
        # For now, we'll return a dummy mapping for demonstration
        return {1: {}, 2: {}, 3: {}}
    
    # Basic Navigation Actions
    
    async def navigate_to(self, action: GoToUrlAction = Body(...)):
        """Navigate to a specified URL"""
        try:
            page = await self.get_current_page()
            await page.goto(action.url)
            await page.wait_for_load_state()
            return {"success": True, "message": f"Navigated to {action.url}"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def search_google(self, action: SearchGoogleAction = Body(...)):
        """Search Google with the provided query"""
        try:
            page = await self.get_current_page()
            search_url = f"https://www.google.com/search?q={action.query}"
            await page.goto(search_url)
            await page.wait_for_load_state()
            return {"success": True, "message": f"Searched for '{action.query}' in Google"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def go_back(self, _: NoParamsAction = Body(...)):
        """Navigate back in browser history"""
        try:
            page = await self.get_current_page()
            await page.go_back()
            await page.wait_for_load_state()
            return {"success": True, "message": "Navigated back"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def wait(self, seconds: int = Body(3)):
        """Wait for the specified number of seconds"""
        try:
            await asyncio.sleep(seconds)
            return {"success": True, "message": f"Waited for {seconds} seconds"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    # Element Interaction Actions
    
    async def click_element(self, action: ClickElementAction = Body(...)):
        """Click on an element by index"""
        try:
            page = await self.get_current_page()
            selector_map = await self.get_selector_map()
            
            if action.index not in selector_map:
                return {"success": False, "error": f"Element with index {action.index} not found"}
            
            # In a real implementation, we would use the selector map to get the element
            # and then click on it. For this example, we're simulating a click.
            # element = selector_map[action.index]
            # await element.click()
            
            return {"success": True, "message": f"Clicked element with index {action.index}"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def input_text(self, action: InputTextAction = Body(...)):
        """Input text into an element"""
        try:
            page = await self.get_current_page()
            selector_map = await self.get_selector_map()
            
            if action.index not in selector_map:
                return {"success": False, "error": f"Element with index {action.index} not found"}
            
            # In a real implementation, we would use the selector map to get the element
            # and then type into it. For this example, we're simulating typing.
            # element = selector_map[action.index]
            # await element.fill(action.text)
            
            return {"success": True, "message": f"Input '{action.text}' into element with index {action.index}"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def send_keys(self, action: SendKeysAction = Body(...)):
        """Send keyboard keys"""
        try:
            page = await self.get_current_page()
            await page.keyboard.press(action.keys)
            return {"success": True, "message": f"Sent keys: {action.keys}"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    # Tab Management Actions
    
    async def switch_tab(self, action: SwitchTabAction = Body(...)):
        """Switch to a different tab by index"""
        try:
            if 0 <= action.page_id < len(self.pages):
                self.current_page_index = action.page_id
                page = await self.get_current_page()
                await page.wait_for_load_state()
                return {"success": True, "message": f"Switched to tab {action.page_id}"}
            else:
                return {"success": False, "error": f"Tab {action.page_id} not found"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def open_tab(self, action: OpenTabAction = Body(...)):
        """Open a new tab with the specified URL"""
        try:
            new_page = await self.browser.new_page()
            await new_page.goto(action.url)
            await new_page.wait_for_load_state()
            self.pages.append(new_page)
            self.current_page_index = len(self.pages) - 1
            return {"success": True, "message": f"Opened new tab with URL: {action.url}"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def close_tab(self, action: CloseTabAction = Body(...)):
        """Close a tab by index"""
        try:
            if 0 <= action.page_id < len(self.pages):
                page = self.pages[action.page_id]
                url = page.url
                await page.close()
                self.pages.pop(action.page_id)
                
                # Adjust current index if needed
                if self.current_page_index >= len(self.pages):
                    self.current_page_index = max(0, len(self.pages) - 1)
                elif self.current_page_index >= action.page_id:
                    self.current_page_index = max(0, self.current_page_index - 1)
                
                return {"success": True, "message": f"Closed tab {action.page_id} with URL: {url}"}
            else:
                return {"success": False, "error": f"Tab {action.page_id} not found"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    # Content Actions
    
    async def extract_content(self, goal: str = Body(...)):
        """Extract content from the current page based on the provided goal"""
        try:
            page = await self.get_current_page()
            content = await page.content()
            
            # In a full implementation, we would use an LLM to extract specific content
            # based on the goal. For this example, we'll return a simplified response.
            simplified_content = f"Page content extracted based on goal: {goal}"
            
            return {"success": True, "content": simplified_content}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def save_pdf(self):
        """Save the current page as a PDF"""
        try:
            page = await self.get_current_page()
            url = page.url
            short_url = re.sub(r'^https?://(?:www\.)?|/$', '', url)
            slug = re.sub(r'[^a-zA-Z0-9]+', '-', short_url).strip('-').lower()
            filename = f"{slug}.pdf"
            
            await page.emulate_media(media="screen")
            await page.pdf(path=filename, format="A4", print_background=False)
            
            return {"success": True, "message": f"Saved page as PDF to ./{filename}"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    # Scroll Actions
    
    async def scroll_down(self, action: ScrollAction = Body(...)):
        """Scroll down the page"""
        try:
            page = await self.get_current_page()
            if action.amount is not None:
                await page.evaluate(f"window.scrollBy(0, {action.amount});")
                amount_str = f"{action.amount} pixels"
            else:
                await page.evaluate("window.scrollBy(0, window.innerHeight);")
                amount_str = "one page"
            
            return {"success": True, "message": f"Scrolled down by {amount_str}"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def scroll_up(self, action: ScrollAction = Body(...)):
        """Scroll up the page"""
        try:
            page = await self.get_current_page()
            if action.amount is not None:
                await page.evaluate(f"window.scrollBy(0, -{action.amount});")
                amount_str = f"{action.amount} pixels"
            else:
                await page.evaluate("window.scrollBy(0, -window.innerHeight);")
                amount_str = "one page"
            
            return {"success": True, "message": f"Scrolled up by {amount_str}"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def scroll_to_text(self, text: str = Body(...)):
        """Scroll to text on the page"""
        try:
            page = await self.get_current_page()
            locators = [
                page.get_by_text(text, exact=False),
                page.locator(f"text={text}"),
                page.locator(f"//*[contains(text(), '{text}')]"),
            ]
            
            for locator in locators:
                try:
                    if await locator.count() > 0 and await locator.first.is_visible():
                        await locator.first.scroll_into_view_if_needed()
                        await asyncio.sleep(0.5)  # Wait for scroll to complete
                        return {"success": True, "message": f"Scrolled to text: {text}"}
                except Exception:
                    continue
            
            return {"success": False, "message": f"Text '{text}' not found or not visible on page"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    # Dropdown Actions
    
    async def get_dropdown_options(self, index: int = Body(...)):
        """Get all options from a dropdown"""
        try:
            page = await self.get_current_page()
            selector_map = await self.get_selector_map()
            
            if index not in selector_map:
                return {"success": False, "error": f"Element with index {index} not found"}
            
            # In a real implementation, we would get the options from the dropdown
            # For this example, we'll return dummy options
            options = [
                {"index": 0, "text": "Option 1", "value": "option1"},
                {"index": 1, "text": "Option 2", "value": "option2"},
                {"index": 2, "text": "Option 3", "value": "option3"},
            ]
            
            return {"success": True, "options": options}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    async def select_dropdown_option(self, index: int = Body(...), text: str = Body(...)):
        """Select an option from a dropdown by text"""
        try:
            page = await self.get_current_page()
            selector_map = await self.get_selector_map()
            
            if index not in selector_map:
                return {"success": False, "error": f"Element with index {index} not found"}
            
            # In a real implementation, we would select the option from the dropdown
            # For this example, we'll return a success message
            
            return {"success": True, "message": f"Selected option '{text}' from dropdown with index {index}"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    # Drag and Drop
    
    async def drag_drop(self, action: DragDropAction = Body(...)):
        """Perform drag and drop operation"""
        try:
            page = await self.get_current_page()
            
            # Element-based drag and drop
            if action.element_source and action.element_target:
                # In a real implementation, we would get the elements and perform the drag
                source_desc = action.element_source
                target_desc = action.element_target
                message = f"Dragged element '{source_desc}' to '{target_desc}'"
            
            # Coordinate-based drag and drop
            elif all(coord is not None for coord in [
                action.coord_source_x, action.coord_source_y, 
                action.coord_target_x, action.coord_target_y
            ]):
                source_x = action.coord_source_x
                source_y = action.coord_source_y
                target_x = action.coord_target_x
                target_y = action.coord_target_y
                
                # In a real implementation, we would perform the drag
                await page.mouse.move(source_x, source_y)
                await page.mouse.down()
                
                steps = max(1, action.steps or 10)
                delay_ms = max(0, action.delay_ms or 5)
                
                for i in range(1, steps + 1):
                    ratio = i / steps
                    intermediate_x = int(source_x + (target_x - source_x) * ratio)
                    intermediate_y = int(source_y + (target_y - source_y) * ratio)
                    await page.mouse.move(intermediate_x, intermediate_y)
                    if delay_ms > 0:
                        await asyncio.sleep(delay_ms / 1000)
                
                await page.mouse.move(target_x, target_y)
                await page.mouse.up()
                
                message = f"Dragged from ({source_x}, {source_y}) to ({target_x}, {target_y})"
            else:
                return {"success": False, "error": "Must provide either source/target selectors or coordinates"}
            
            return {"success": True, "message": message}
        except Exception as e:
            return {"success": False, "error": str(e)}

# Create singleton instance
automation_service = BrowserAutomation()

# Create API app
api_app = FastAPI()

@api_app.get("/api")
async def health_check():
    return {"status": "ok", "message": "API server is running"}

# Include automation service router with /api prefix
api_app.include_router(automation_service.router, prefix="/api")

async def test_browser_api():
    """Test the browser automation API functionality"""
    try:
        # Initialize browser automation
        await automation_service.startup()

        # Test basic navigation
        result = await automation_service.navigate_to(GoToUrlAction(url="https://www.example.com"))
        assert result["success"], "Navigation failed"

        await asyncio.sleep(10)

        # Test search functionality
        result = await automation_service.search_google(SearchGoogleAction(query="test query"))
        assert result["success"], "Google search failed"

        await asyncio.sleep(10)

        # Test tab management
        result = await automation_service.open_tab(OpenTabAction(url="https://www.example.org"))
        assert result["success"], "Opening new tab failed"

        await asyncio.sleep(10)

        result = await automation_service.switch_tab(SwitchTabAction(page_id=0))
        assert result["success"], "Switching tab failed"

        await asyncio.sleep(10)

        # Test scrolling
        result = await automation_service.scroll_down(ScrollAction(amount=100))
        assert result["success"], "Scrolling down failed"

        await asyncio.sleep(10)

        result = await automation_service.scroll_up(ScrollAction(amount=50))
        assert result["success"], "Scrolling up failed"

        await asyncio.sleep(10)

        # Test content extraction
        result = await automation_service.extract_content("test goal")
        assert result["success"], "Content extraction failed"

        # Test cleanup
        # await automation_service.shutdown()
        print("All tests passed successfully!")

    except Exception as e:
        print(f"Test failed: {str(e)}")
        raise
    finally:
        # Ensure browser is closed
        # await automation_service.shutdown()
        pass

if __name__ == '__main__':
    import uvicorn
    print("Starting API server")
    uvicorn.run("browser_api:api_app", host="0.0.0.0", port=8002)
    # asyncio.run(test_browser_api())