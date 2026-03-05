from typing import Optional, Dict, Any, List, Literal
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
from core.utils.image_processing import upscale_image_sync, remove_background_sync, UPSCALE_MODEL, REMOVE_BG_MODEL
from core.billing.credits.media_integration import media_billing
import json
import uuid
import asyncio
import io
import os
from datetime import datetime
from PIL import Image

# Global lock for canvas file operations to prevent race conditions
_canvas_locks: Dict[str, asyncio.Lock] = {}


@tool_metadata(
    display_name="Canvas Editor",
    description="Create and manage interactive canvases for image composition and design. Includes frames for export regions and AI processing (upscale, remove background).",
    icon="Layout",
    color="bg-blue-100 dark:bg-blue-800/50",
    weight=215,
    visible=True,
    usage_guide="""
### CANVAS EDITOR - SOCIAL MEDIA WORKFLOW

**MANDATORY for Instagram, TikTok, YouTube, any sized design:**

1. add_frame_to_canvas(canvas_path="canvases/design.kanvax", width=1080, height=1920, background_color="#000000") → get element_id
2. image_edit_or_generate(prompt="...", canvas_path="canvases/design.kanvax", frame_id=element_id, aspect_ratio="2:3")

**⚠️ CRITICAL RULES:**
- BOTH canvas_path AND frame_id are REQUIRED in image_edit_or_generate!
- Generate **ONE COMPREHENSIVE IMAGE** per post - include ALL text, logos, and design in ONE prompt!
- Do NOT generate multiple images for text overlays!

**SIZES & ASPECT RATIOS:**
- IG Story/Reel/TikTok: 1080x1920 → aspect_ratio="2:3" (portrait)
- IG Post: 1080x1080 → aspect_ratio="1:1" (square)
- LinkedIn Post: 1200x627 → aspect_ratio="3:2" (landscape)
- YouTube: 1280x720 → aspect_ratio="3:2" (landscape)
- Twitter: 1200x675 → aspect_ratio="3:2" (landscape)

**⚠️ CREATE ONLY ONE FRAME AND ONE IMAGE PER REQUEST!**

**FRAME FILL:** Use background_color="#000000" (black) to fill gaps!

**NEVER create HTML for social media content!**

**🎨 AI PROCESSING ON CANVAS ELEMENTS:**
```python
# List elements to get IDs
list_canvas_elements(canvas_path="canvases/my-design.kanvax")

# Upscale an image on the canvas
ai_process_canvas_element(
    canvas_path="canvases/my-design.kanvax",
    element_id="abc-123",
    action="upscale"
)

# Remove background from an image on the canvas
ai_process_canvas_element(
    canvas_path="canvases/my-design.kanvax",
    element_id="abc-123",
    action="remove_bg"
)
```

**⚠️ RULES:**
- NEVER call add_image_to_canvas in PARALLEL - causes race conditions!
- Use list_canvas_elements to get element IDs before processing
- For frame sizes not in presets: ASK the user OR use web_search to find dimensions
"""
)
class SandboxCanvasTool(SandboxToolsBase):
    """
    Canvas tool for creating and managing interactive canvases with image elements.
    Canvases are stored as .kanvax files (JSON format) with element metadata.
    """
    
    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.canvases_dir = "canvases"
        self.images_dir = f"{self.canvases_dir}/images"
    
    def _get_canvas_lock(self, canvas_path: str) -> asyncio.Lock:
        """Get or create a lock for a specific canvas file to prevent race conditions"""
        global _canvas_locks
        lock_key = f"{self.project_id}:{canvas_path}"
        if lock_key not in _canvas_locks:
            _canvas_locks[lock_key] = asyncio.Lock()
        return _canvas_locks[lock_key]

    async def _ensure_canvases_dir(self):
        """Ensure the canvases directory exists"""
        await self._ensure_sandbox()
        full_path = f"{self.workspace_path}/{self.canvases_dir}"
        logger.debug(f"[Canvas] Creating directory: {full_path} in sandbox {self._sandbox_id}")
        try:
            result = await self.sandbox.process.exec(f"mkdir -p '{full_path}'")
            # Verify directory was created
            verify = await self.sandbox.process.exec(f"test -d '{full_path}' && echo 'EXISTS'")
            if hasattr(verify, 'stdout') and 'EXISTS' in str(verify.stdout):
                logger.debug(f"[Canvas] Directory verified: {full_path}")
            else:
                logger.warning(f"[Canvas] Directory may not exist: {full_path}")
        except Exception as e:
            logger.error(f"[Canvas] Failed to create directory {full_path}: {e}")

    async def _ensure_images_dir(self):
        """Ensure the images directory exists"""
        await self._ensure_sandbox()
        full_path = f"{self.workspace_path}/{self.images_dir}"
        try:
            await self.sandbox.process.exec(f"mkdir -p '{full_path}'")
        except Exception as e:
            logger.error(f"[Canvas] Failed to create images dir {full_path}: {e}")

    def _sanitize_filename(self, name: str) -> str:
        """Convert canvas name to safe filename"""
        return "".join(c for c in name if c.isalnum() or c in "-_").lower()

    def _normalize_path(self, path: str) -> str:
        """Normalize canvas/file paths to relative paths.
        
        Handles:
        - Absolute paths like /workspace/canvases/foo.kanvax -> canvases/foo.kanvax
        - Malformed paths with XML garbage
        - Extra slashes
        """
        if not path:
            return path
        
        # Strip any XML-like garbage that LLMs sometimes generate
        if '</parameter>' in path or '<parameter' in path:
            # Take only the part before any XML tags
            path = path.split('</parameter>')[0].split('<parameter')[0].strip()
        
        # Remove /workspace/ prefix if present
        if path.startswith('/workspace/'):
            path = path[11:]  # len('/workspace/') = 11
        elif path.startswith('workspace/'):
            path = path[10:]  # len('workspace/') = 10
        
        # Remove leading slashes
        path = path.lstrip('/')
        
        # Clean up any double slashes
        while '//' in path:
            path = path.replace('//', '/')
        
        return path

    def _create_canvas_data(
        self, 
        name: str, 
        description: Optional[str] = None,
        background: str = "#1a1a1a"  # Dark background by default
    ) -> Dict[str, Any]:
        """Create initial canvas data structure - infinite canvas, no fixed dimensions"""
        now = datetime.utcnow().isoformat() + "Z"
        return {
            "name": name,
            "version": "1.0",
            "background": background,
            "description": description or "",
            "elements": [],
            "created_at": now,
            "updated_at": now
        }

    async def _load_canvas_data(self, canvas_path: str) -> Optional[Dict[str, Any]]:
        """Load canvas data from .kanvax file"""
        try:
            await self._ensure_sandbox()
            # Normalize path to handle /workspace/ prefix and other issues
            normalized_path = self._normalize_path(canvas_path)
            full_path = f"{self.workspace_path}/{normalized_path}"
            logger.debug(f"[Canvas] Loading canvas from: {full_path} (original: {canvas_path})")
            content = await self.sandbox.fs.download_file(full_path)
            return json.loads(content.decode() if isinstance(content, bytes) else content)
        except Exception as e:
            logger.warning(f"[Canvas] Failed to load canvas {canvas_path}: {e}")
            return None

    async def _save_canvas_data(self, canvas_path: str, canvas_data: Dict[str, Any]):
        """Save canvas data to .kanvax file"""
        try:
            await self._ensure_sandbox()
            await self._ensure_canvases_dir()  # Ensure directory exists!
            
            # Normalize path
            normalized_path = self._normalize_path(canvas_path)
            canvas_data["updated_at"] = datetime.utcnow().isoformat() + "Z"
            content = json.dumps(canvas_data, indent=2)
            full_path = f"{self.workspace_path}/{normalized_path}"
            
            logger.debug(f"[Canvas] Saving canvas to: {full_path} (original: {canvas_path})")
            await self.sandbox.fs.upload_file(content.encode(), full_path)
            
            # Verify file was saved
            try:
                verify = await self.sandbox.process.exec(f"test -f '{full_path}' && echo 'SAVED'")
                if hasattr(verify, 'stdout') and 'SAVED' in str(verify.stdout):
                    logger.debug(f"[Canvas] File verified: {full_path}")
                else:
                    logger.warning(f"[Canvas] File may not have been saved: {full_path}")
            except:
                pass
        except Exception as e:
            logger.error(f"[Canvas] Failed to save canvas {full_path}: {e}")
            raise Exception(f"Failed to save canvas: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_canvas",
            "description": "Create a new infinite canvas for image composition and design. Canvas is infinite - no fixed dimensions. Just add images at any position. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `name` (REQUIRED), `description` (optional), `background` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "**REQUIRED** - Name for the canvas (will be sanitized for filename). Use descriptive names like 'product-mockup' or 'social-media-banner'."
                    },
                    "description": {
                        "type": "string",
                        "description": "**OPTIONAL** - Description of the canvas purpose or content."
                    },
                    "background": {
                        "type": "string",
                        "description": "**OPTIONAL** - Background color in hex format. Example: '#1a1a1a' for dark, '#ffffff' for white. Default: '#1a1a1a'.",
                        "default": "#1a1a1a"
                    }
                },
                "required": ["name"],
                "additionalProperties": False
            }
        }
    })
    async def create_canvas(
        self,
        name: str,
        description: Optional[str] = None,
        background: str = "#1a1a1a"
    ) -> ToolResult:
        """Create a new infinite canvas"""
        try:
            await self._ensure_sandbox()
            logger.info(f"[Canvas] Creating canvas '{name}' in sandbox {self._sandbox_id} for project {self.project_id}")
            await self._ensure_canvases_dir()
            await self._ensure_images_dir()

            safe_name = self._sanitize_filename(name)
            canvas_path = f"{self.canvases_dir}/{safe_name}.kanvax"
            full_path = f"{self.workspace_path}/{canvas_path}"

            # Check if canvas already exists
            try:
                await self.sandbox.fs.download_file(full_path)
                return self.fail_response(f"Canvas '{name}' already exists at {canvas_path}")
            except:
                pass  # File doesn't exist, continue

            # Create canvas data (infinite canvas - no dimensions)
            canvas_data = self._create_canvas_data(name, description, background)

            # Save canvas file
            await self._save_canvas_data(canvas_path, canvas_data)

            result = {
                "canvas_name": name,
                "canvas_path": canvas_path,
                "background": background,
                "description": description or "",
                "sandbox_id": self.sandbox_id,
                "message": f"Canvas '{name}' created successfully at {canvas_path}"
            }

            return self.success_response(result)

        except Exception as e:
            return self.fail_response(f"Failed to create canvas: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "save_canvas",
            "description": "Save canvas data with all elements. Used to persist user changes from the canvas editor. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `canvas_path` (REQUIRED), `elements` (REQUIRED). **⚠️ IMPORTANT**: For frame elements, include `backgroundColor` to preserve fill color!",
            "parameters": {
                "type": "object",
                "properties": {
                    "canvas_path": {
                        "type": "string",
                        "description": "**REQUIRED** - Path to the canvas file. Example: 'canvases/project-mockup.kanvax'"
                    },
                    "elements": {
                        "type": "array",
                        "description": "**REQUIRED** - Array of canvas elements with their properties. For frames: include backgroundColor to preserve fill color!",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "type": {"type": "string", "description": "'image' or 'frame'"},
                                "src": {"type": "string", "description": "Image source path (for image type only)"},
                                "x": {"type": "number"},
                                "y": {"type": "number"},
                                "width": {"type": "number"},
                                "height": {"type": "number"},
                                "rotation": {"type": "number"},
                                "scaleX": {"type": "number"},
                                "scaleY": {"type": "number"},
                                "opacity": {"type": "number"},
                                "locked": {"type": "boolean"},
                                "name": {"type": "string"},
                                "backgroundColor": {"type": "string", "description": "**FOR FRAMES ONLY** - Fill color in hex format (e.g. '#000000'). MUST preserve from list_canvas_elements!"}
                            }
                        }
                    }
                },
                "required": ["canvas_path", "elements"],
                "additionalProperties": False
            }
        }
    })
    async def save_canvas(
        self,
        canvas_path: str,
        elements: List[Dict[str, Any]]
    ) -> ToolResult:
        """
        Save canvas with updated elements.
        """
        # Normalize path
        canvas_path = self._normalize_path(canvas_path)
        
        try:
            await self._ensure_sandbox()
            
            # Load existing canvas
            canvas_data = await self._load_canvas_data(canvas_path)
            if not canvas_data:
                return self.fail_response(f"Canvas not found: {canvas_path}")
            
            # Update elements
            canvas_data["elements"] = elements
            canvas_data["updated_at"] = datetime.now().isoformat()
            
            # Save back to file
            await self._save_canvas_data(canvas_path, canvas_data)
            
            result = {
                "canvas_path": canvas_path,
                "canvas_name": canvas_data.get("name", ""),
                "element_count": len(elements),
                "sandbox_id": self.sandbox_id,
                "message": f"Canvas saved with {len(elements)} element(s)"
            }
            
            return self.success_response(result)
        
        except Exception as e:
            return self.fail_response(f"Failed to save canvas: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "add_image_to_canvas",
            "description": "Add an image element to an existing canvas. Image can be from designs folder or any workspace path. **⚠️ IMPORTANT**: NEVER call this function in parallel - causes race conditions! Call ONE AT A TIME. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `canvas_path` (REQUIRED), `image_path` (REQUIRED), `x` (optional), `y` (optional), `width` (optional), `height` (optional), `name` (optional), `frame_id` (optional for precise frame placement).",
            "parameters": {
                "type": "object",
                "properties": {
                    "canvas_path": {
                        "type": "string",
                        "description": "**REQUIRED** - Path to the canvas file. Example: 'canvases/project-mockup.kanvax'"
                    },
                    "image_path": {
                        "type": "string",
                        "description": "**REQUIRED** - Path to the image file relative to workspace. Example: 'designs/logo.png'"
                    },
                    "x": {
                        "type": "number",
                        "description": "**OPTIONAL** - X position on canvas in pixels. Default: 100. Ignored if frame_id is provided.",
                        "default": 100
                    },
                    "y": {
                        "type": "number",
                        "description": "**OPTIONAL** - Y position on canvas in pixels. Default: 100. Ignored if frame_id is provided.",
                        "default": 100
                    },
                    "width": {
                        "type": "number",
                        "description": "**OPTIONAL** - Width of the image in pixels. Uses original size if not specified. Minimum: 1.",
                        "minimum": 1
                    },
                    "height": {
                        "type": "number",
                        "description": "**OPTIONAL** - Height of the image in pixels. Uses original size if not specified. Minimum: 1.",
                        "minimum": 1
                    },
                    "name": {
                        "type": "string",
                        "description": "**OPTIONAL** - Name for the element. Defaults to image filename if not provided."
                    },
                    "frame_id": {
                        "type": "string",
                        "description": "**OPTIONAL** - Frame element ID to place image inside. Image will be centered and scaled to fit within the frame. Use list_canvas_elements to get frame IDs."
                    }
                },
                "required": ["canvas_path", "image_path"],
                "additionalProperties": False
            }
        }
    })
    async def add_image_to_canvas(
        self,
        canvas_path: str,
        image_path: str,
        x: float = 100,
        y: float = 100,
        width: Optional[float] = None,
        height: Optional[float] = None,
        name: Optional[str] = None,
        frame_id: Optional[str] = None
    ) -> ToolResult:
        """Add an image element to the canvas"""
        # Normalize paths to handle /workspace/ prefix and XML garbage
        canvas_path = self._normalize_path(canvas_path)
        image_path = self._normalize_path(image_path)
        
        # Ensure x, y, width, height are numbers (AI sometimes passes strings)
        try:
            x = float(x) if x is not None else 100
            y = float(y) if y is not None else 100
            width = float(width) if width is not None else None
            height = float(height) if height is not None else None
        except (ValueError, TypeError):
            x, y = 100, 100
            width, height = None, None
        
        # Use lock to prevent race conditions when parallel calls try to add images
        canvas_lock = self._get_canvas_lock(canvas_path)
        
        async with canvas_lock:
            try:
                await self._ensure_sandbox()
                
                # Load canvas data (inside lock to ensure atomic read-modify-write)
                canvas_data = await self._load_canvas_data(canvas_path)
                if not canvas_data:
                    return self.fail_response(f"Canvas not found: {canvas_path}")

                # Verify image exists and load it
                image_full_path = f"{self.workspace_path}/{image_path}"
                try:
                    image_data = await self.sandbox.fs.download_file(image_full_path)
                except:
                    return self.fail_response(f"Image not found at {image_path}")
                
                # Get image bytes to read dimensions (not for embedding)
                if isinstance(image_data, bytes):
                    image_bytes = image_data
                else:
                    image_bytes = image_data.encode()
                
                # Get actual image dimensions using PIL
                try:
                    img = Image.open(io.BytesIO(image_bytes))
                    actual_img_width, actual_img_height = img.size
                    img.close()
                except Exception as e:
                    logger.warning(f"Could not read image dimensions: {e}")
                    actual_img_width, actual_img_height = 400, 400
                
                # Create element - store PATH reference, NOT base64 (avoids LLM context bloat)
                # Frontend canvas-renderer.tsx handles path-based src via getSandboxFileUrl()
                element_id = str(uuid.uuid4())
                element_name = name or image_path.split('/')[-1]
                
                # Calculate element size based on actual image dimensions
                # If user provided both width and height, scale proportionally to fit
                # If user provided only one, scale to maintain aspect ratio
                # If user provided neither, use actual image size (capped at reasonable max)
                aspect_ratio = actual_img_width / actual_img_height if actual_img_height > 0 else 1
                
                if width is not None and height is not None:
                    # User specified both - scale to fit while maintaining aspect ratio
                    target_aspect = width / height if height > 0 else 1
                    if aspect_ratio > target_aspect:
                        # Image is wider, fit to width
                        elem_width = width
                        elem_height = width / aspect_ratio
                    else:
                        # Image is taller, fit to height
                        elem_height = height
                        elem_width = height * aspect_ratio
                elif width is not None:
                    # User specified only width
                    elem_width = width
                    elem_height = width / aspect_ratio
                elif height is not None:
                    # User specified only height
                    elem_height = height
                    elem_width = height * aspect_ratio
                else:
                    # No size specified - use actual image size (no cap - canvas is infinite)
                    elem_width = actual_img_width
                    elem_height = actual_img_height
                
                # Handle frame_id placement - find frame and position/size to fit inside
                target_frame = None
                if frame_id:
                    for el in canvas_data.get("elements", []):
                        if el.get("id") == frame_id and el.get("type") == "frame":
                            target_frame = el
                            break
                    if not target_frame:
                        logger.warning(f"Frame {frame_id} not found in canvas, using default positioning")
                
                # Calculate position
                actual_x = x
                actual_y = y
                
                if target_frame:
                    # Place inside frame - scale to fit and center
                    frame_w = target_frame["width"]
                    frame_h = target_frame["height"]
                    
                    # Scale image to fit within frame while maintaining aspect ratio
                    img_aspect = actual_img_width / actual_img_height if actual_img_height > 0 else 1
                    frame_aspect = frame_w / frame_h if frame_h > 0 else 1
                    
                    if img_aspect > frame_aspect:
                        # Image is wider than frame - fit to width
                        elem_width = frame_w
                        elem_height = frame_w / img_aspect
                    else:
                        # Image is taller than frame - fit to height
                        elem_height = frame_h
                        elem_width = frame_h * img_aspect
                    
                    # Center inside frame
                    actual_x = target_frame["x"] + (frame_w - elem_width) / 2
                    actual_y = target_frame["y"] + (frame_h - elem_height) / 2
                    
                elif x == 100 and y == 100 and len(canvas_data["elements"]) > 0:
                    # Auto-calculate position in grid layout
                    existing = canvas_data["elements"]
                    cols = 3  # 3 columns
                    gap = 50  # Gap between elements
                    
                    index = len(existing)
                    col = index % cols
                    row = index // cols
                    
                    # Find max width/height in each row for better alignment
                    actual_x = col * (elem_width + gap) + 100
                    actual_y = row * (elem_height + gap) + 100

                element = {
                    "id": element_id,
                    "type": "image",
                    "src": image_path,  # Store path reference - frontend fetches via sandbox API
                    "x": actual_x,
                    "y": actual_y,
                    "width": elem_width,
                    "height": elem_height,
                    "rotation": 0,
                    "scaleX": 1,
                    "scaleY": 1,
                    "opacity": 1,
                    "locked": False,
                    "name": element_name
                }

                # Add to canvas
                canvas_data["elements"].append(element)

                # Save canvas
                await self._save_canvas_data(canvas_path, canvas_data)

                result = {
                    "canvas_path": canvas_path,
                    "element_id": element_id,
                    "element_name": element_name,
                    "image_path": image_path,
                    "position": {"x": actual_x, "y": actual_y},
                    "size": {"width": elem_width, "height": elem_height},
                    "total_elements": len(canvas_data["elements"]),
                    "sandbox_id": self.sandbox_id,
                    "message": f"Added '{element_name}' to canvas at position ({actual_x}, {actual_y})"
                }

                return self.success_response(result)

            except Exception as e:
                return self.fail_response(f"Failed to add image to canvas: {str(e)}")

    # Frame size presets - common sizes for design work
    FRAME_PRESETS = {
        # Social Media
        "instagram_post": {"width": 1080, "height": 1080, "name": "Instagram Post"},
        "instagram_story": {"width": 1080, "height": 1920, "name": "Instagram Story"},
        "instagram_reel": {"width": 1080, "height": 1920, "name": "Instagram Reel"},
        "facebook_post": {"width": 1200, "height": 630, "name": "Facebook Post"},
        "facebook_cover": {"width": 820, "height": 312, "name": "Facebook Cover"},
        "twitter_post": {"width": 1200, "height": 675, "name": "Twitter/X Post"},
        "twitter_header": {"width": 1500, "height": 500, "name": "Twitter/X Header"},
        "linkedin_post": {"width": 1200, "height": 627, "name": "LinkedIn Post"},
        "linkedin_cover": {"width": 1584, "height": 396, "name": "LinkedIn Cover"},
        "youtube_thumbnail": {"width": 1280, "height": 720, "name": "YouTube Thumbnail"},
        "tiktok_video": {"width": 1080, "height": 1920, "name": "TikTok Video"},
        "pinterest_pin": {"width": 1000, "height": 1500, "name": "Pinterest Pin"},
        # Devices
        "iphone_15_pro": {"width": 1179, "height": 2556, "name": "iPhone 15 Pro"},
        "iphone_15": {"width": 1170, "height": 2532, "name": "iPhone 15"},
        "iphone_se": {"width": 750, "height": 1334, "name": "iPhone SE"},
        "ipad_pro_12": {"width": 2048, "height": 2732, "name": "iPad Pro 12.9\""},
        "ipad_pro_11": {"width": 1668, "height": 2388, "name": "iPad Pro 11\""},
        "android_phone": {"width": 1080, "height": 2340, "name": "Android Phone"},
        "macbook_pro_16": {"width": 3456, "height": 2234, "name": "MacBook Pro 16\""},
        "macbook_air_15": {"width": 2880, "height": 1864, "name": "MacBook Air 15\""},
        # Design Platforms
        "dribbble_shot": {"width": 1600, "height": 1200, "name": "Dribbble Shot"},
        "behance_project": {"width": 1400, "height": 1050, "name": "Behance Project"},
        "figma_frame": {"width": 1440, "height": 900, "name": "Figma Desktop"},
        # Print
        "a4_portrait": {"width": 2480, "height": 3508, "name": "A4 Portrait (300dpi)"},
        "a4_landscape": {"width": 3508, "height": 2480, "name": "A4 Landscape (300dpi)"},
        "a3_portrait": {"width": 3508, "height": 4961, "name": "A3 Portrait (300dpi)"},
        "letter_portrait": {"width": 2550, "height": 3300, "name": "US Letter Portrait"},
        "business_card": {"width": 1050, "height": 600, "name": "Business Card"},
        "poster_24x36": {"width": 7200, "height": 10800, "name": "Poster 24x36\""},
        # Common Aspect Ratios
        "hd_1080p": {"width": 1920, "height": 1080, "name": "HD 1080p"},
        "hd_720p": {"width": 1280, "height": 720, "name": "HD 720p"},
        "4k_uhd": {"width": 3840, "height": 2160, "name": "4K UHD"},
        "square_1000": {"width": 1000, "height": 1000, "name": "Square 1000px"},
        "square_2000": {"width": 2000, "height": 2000, "name": "Square 2000px"},
    }

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "add_frame_to_canvas",
            "description": """⚠️ CALL THIS FIRST for Instagram/TikTok/YouTube/any sized design! Returns frame_id to use with image_edit_or_generate. Auto-creates canvas.

**SIZES:** IG Story/Reel/TikTok=1080x1920, IG Post=1080x1080, YouTube=1280x720, Twitter=1200x675""",
            "parameters": {
                "type": "object",
                "properties": {
                    "canvas_path": {
                        "type": "string",
                        "description": "**REQUIRED** - Path to the canvas file. Example: 'canvases/project-mockup.kanvax'"
                    },
                    "name": {
                        "type": "string",
                        "description": "**REQUIRED** - Name for the frame. Use descriptive names like 'Instagram Post 1', 'Hero Banner', 'Mobile Screenshot'."
                    },
                    "width": {
                        "type": "number",
                        "description": "**REQUIRED** - Width of the frame in pixels. Use preset dimensions for common formats.",
                        "minimum": 100
                    },
                    "height": {
                        "type": "number",
                        "description": "**REQUIRED** - Height of the frame in pixels. Use preset dimensions for common formats.",
                        "minimum": 100
                    },
                    "x": {
                        "type": "number",
                        "description": "**OPTIONAL** - X position on canvas in pixels. Default: 100.",
                        "default": 100
                    },
                    "y": {
                        "type": "number",
                        "description": "**OPTIONAL** - Y position on canvas in pixels. Default: 100.",
                        "default": 100
                    },
                    "background_color": {
                        "type": "string",
                        "description": "**OPTIONAL** - Background color in hex format. Example: '#ffffff' for white, '#000000' for black, 'transparent' for no background. Default: transparent.",
                        "default": "transparent"
                    }
                },
                "required": ["canvas_path", "name", "width", "height"],
                "additionalProperties": False
            }
        }
    })
    async def add_frame_to_canvas(
        self,
        canvas_path: str,
        name: str,
        width: float,
        height: float,
        x: float = 100,
        y: float = 100,
        background_color: str = "transparent"
    ) -> ToolResult:
        """Add a frame element to the canvas"""
        # Normalize path to handle /workspace/ prefix and XML garbage
        canvas_path = self._normalize_path(canvas_path)
        
        # Ensure dimensions are valid numbers
        try:
            width = float(width) if width is not None else 400
            height = float(height) if height is not None else 400
            x = float(x) if x is not None else 100
            y = float(y) if y is not None else 100
        except (ValueError, TypeError):
            return self.fail_response("Invalid dimensions provided. Width and height must be numbers.")
        
        # Validate minimum size
        if width < 100 or height < 100:
            return self.fail_response("Frame dimensions must be at least 100x100 pixels.")
        
        # Use lock to prevent race conditions
        canvas_lock = self._get_canvas_lock(canvas_path)
        
        async with canvas_lock:
            try:
                await self._ensure_sandbox()
                
                # Ensure canvas_path has correct format
                if not canvas_path.endswith('.kanvax'):
                    canvas_path = f"{canvas_path}.kanvax"
                if not canvas_path.startswith('canvases/'):
                    canvas_path = f"canvases/{canvas_path}"
                
                # Ensure canvases directory exists
                canvases_dir = f"{self.workspace_path}/canvases"
                await self.sandbox.process.exec(f"mkdir -p '{canvases_dir}'")
                
                # Load canvas data or create new one
                canvas_data = await self._load_canvas_data(canvas_path)
                if not canvas_data:
                    # Auto-create canvas
                    canvas_name = canvas_path.split('/')[-1].replace('.kanvax', '')
                    canvas_data = {
                        "name": canvas_name,
                        "version": "1.0",
                        "background": "#1a1a1a",
                        "description": f"Auto-created canvas for {canvas_name}",
                        "elements": [],
                        "created_at": datetime.now().isoformat(),
                        "updated_at": datetime.now().isoformat(),
                    }
                
                # Create frame element
                element_id = str(uuid.uuid4())
                
                # Auto-calculate position if using defaults and other frames exist
                actual_x = x
                actual_y = y
                if x == 100 and y == 100:
                    # Find existing frames and offset new one
                    existing_frames = [el for el in canvas_data["elements"] if el.get("type") == "frame"]
                    if existing_frames:
                        # Place next to the last frame with gap
                        last_frame = existing_frames[-1]
                        actual_x = last_frame["x"] + last_frame["width"] + 100
                        actual_y = last_frame["y"]
                
                element = {
                    "id": element_id,
                    "type": "frame",
                    "x": actual_x,
                    "y": actual_y,
                    "width": width,
                    "height": height,
                    "rotation": 0,
                    "opacity": 1,
                    "locked": False,
                    "name": name,
                    "visible": True,
                    "backgroundColor": background_color if background_color != "transparent" else None
                }
                
                # Add frame to canvas (frames should be at the beginning so they render behind images)
                # Insert at the beginning of elements array
                canvas_data["elements"].insert(0, element)
                
                # Save canvas
                await self._save_canvas_data(canvas_path, canvas_data)
                
                result = {
                    "canvas_path": canvas_path,
                    "element_id": element_id,
                    "element_name": name,
                    "element_type": "frame",
                    "position": {"x": actual_x, "y": actual_y},
                    "size": {"width": width, "height": height},
                    "backgroundColor": background_color if background_color != "transparent" else None,
                    "total_elements": len(canvas_data["elements"]),
                    "sandbox_id": self.sandbox_id,
                    "message": f"Added frame '{name}' ({int(width)}x{int(height)}) to canvas at position ({int(actual_x)}, {int(actual_y)})"
                }
                
                return self.success_response(result)
                
            except Exception as e:
                return self.fail_response(f"Failed to add frame to canvas: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_canvas_elements",
            "description": "List all elements in a canvas with their properties. **🚨 PARAMETER NAMES**: Use EXACTLY this parameter name: `canvas_path` (REQUIRED).",
            "parameters": {
                "type": "object",
                "properties": {
                    "canvas_path": {
                        "type": "string",
                        "description": "**REQUIRED** - Path to the canvas file. Example: 'canvases/project-mockup.kanvax'"
                    }
                },
                "required": ["canvas_path"],
                "additionalProperties": False
            }
        }
    })
    async def list_canvas_elements(self, canvas_path: str) -> ToolResult:
        """List all elements in a canvas"""
        # Normalize path
        canvas_path = self._normalize_path(canvas_path)
        
        try:
            await self._ensure_sandbox()
            canvas_data = await self._load_canvas_data(canvas_path)
            
            if not canvas_data:
                return self.fail_response(f"Canvas not found: {canvas_path}")

            elements_info = []
            for element in canvas_data.get("elements", []):
                element_type = element.get("type", "image")
                
                # Build base info common to all element types
                elem_info = {
                    "id": element["id"],
                    "name": element["name"],
                    "type": element_type,
                    "position": {"x": element["x"], "y": element["y"]},
                    "size": {"width": element["width"], "height": element["height"]},
                    "rotation": element.get("rotation", 0),
                    "opacity": element.get("opacity", 1),
                    "locked": element.get("locked", False)
                }
                
                # Add type-specific info
                if element_type == "image":
                    # Get src info but NEVER include base64 data in tool results (LLM context bloat)
                    src = element.get("src", "")
                    if src.startswith("data:"):
                        # Base64 embedded - just indicate it exists
                        src_info = "(embedded image)"
                    else:
                        # File path reference - safe to include
                        src_info = src
                    elem_info["src"] = src_info
                elif element_type == "frame":
                    # Frame-specific properties (use camelCase to match save_canvas format)
                    elem_info["backgroundColor"] = element.get("backgroundColor", "transparent")
                
                elements_info.append(elem_info)

            result = {
                "canvas_name": canvas_data["name"],
                "canvas_path": canvas_path,
                "background": canvas_data.get("background", "#1a1a1a"),
                "total_elements": len(elements_info),
                "elements": elements_info,
                "sandbox_id": self.sandbox_id
            }

            return self.success_response(result)

        except Exception as e:
            return self.fail_response(f"Failed to list canvas elements: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "update_canvas_element",
            "description": "Update properties of a canvas element (position, size, rotation, etc.). **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `canvas_path` (REQUIRED), `element_id` (REQUIRED), `x` (optional), `y` (optional), `width` (optional), `height` (optional), `rotation` (optional), `opacity` (optional), `locked` (optional), `name` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "canvas_path": {
                        "type": "string",
                        "description": "**REQUIRED** - Path to the canvas file. Example: 'canvases/project-mockup.kanvax'"
                    },
                    "element_id": {
                        "type": "string",
                        "description": "**REQUIRED** - ID of the element to update."
                    },
                    "x": {"type": "number", "description": "**OPTIONAL** - New X position in pixels."},
                    "y": {"type": "number", "description": "**OPTIONAL** - New Y position in pixels."},
                    "width": {"type": "number", "description": "**OPTIONAL** - New width in pixels."},
                    "height": {"type": "number", "description": "**OPTIONAL** - New height in pixels."},
                    "rotation": {"type": "number", "description": "**OPTIONAL** - Rotation in degrees."},
                    "opacity": {"type": "number", "description": "**OPTIONAL** - Opacity value between 0 and 1. Minimum: 0, Maximum: 1.", "minimum": 0, "maximum": 1},
                    "locked": {"type": "boolean", "description": "**OPTIONAL** - Lock element to prevent changes."},
                    "name": {"type": "string", "description": "**OPTIONAL** - Element name."}
                },
                "required": ["canvas_path", "element_id"],
                "additionalProperties": False
            }
        }
    })
    async def update_canvas_element(
        self,
        canvas_path: str,
        element_id: str,
        **updates
    ) -> ToolResult:
        """Update element properties"""
        # Normalize path
        canvas_path = self._normalize_path(canvas_path)
        
        try:
            await self._ensure_sandbox()
            canvas_data = await self._load_canvas_data(canvas_path)
            
            if not canvas_data:
                return self.fail_response(f"Canvas not found: {canvas_path}")

            # Find element
            element = None
            for el in canvas_data.get("elements", []):
                if el["id"] == element_id:
                    element = el
                    break

            if not element:
                return self.fail_response(f"Element '{element_id}' not found in canvas")

            # Update properties
            allowed_updates = ["x", "y", "width", "height", "rotation", "opacity", "locked", "name", "scaleX", "scaleY"]
            updated_props = []
            for key, value in updates.items():
                if key in allowed_updates and value is not None:
                    element[key] = value
                    updated_props.append(key)

            # Save canvas
            await self._save_canvas_data(canvas_path, canvas_data)

            result = {
                "canvas_path": canvas_path,
                "element_id": element_id,
                "element_name": element["name"],
                "updated_properties": updated_props,
                "sandbox_id": self.sandbox_id,
                "message": f"Updated element '{element['name']}' ({len(updated_props)} properties)"
            }

            return self.success_response(result)

        except Exception as e:
            return self.fail_response(f"Failed to update element: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "remove_canvas_element",
            "description": "Remove an element from the canvas. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `canvas_path` (REQUIRED), `element_id` (REQUIRED).",
            "parameters": {
                "type": "object",
                "properties": {
                    "canvas_path": {
                        "type": "string",
                        "description": "**REQUIRED** - Path to the canvas file. Example: 'canvases/project-mockup.kanvax'"
                    },
                    "element_id": {
                        "type": "string",
                        "description": "**REQUIRED** - ID of the element to remove."
                    }
                },
                "required": ["canvas_path", "element_id"],
                "additionalProperties": False
            }
        }
    })
    async def remove_canvas_element(self, canvas_path: str, element_id: str) -> ToolResult:
        """Remove an element from the canvas"""
        # Normalize path
        canvas_path = self._normalize_path(canvas_path)
        
        try:
            await self._ensure_sandbox()
            canvas_data = await self._load_canvas_data(canvas_path)
            
            if not canvas_data:
                return self.fail_response(f"Canvas not found: {canvas_path}")

            # Find and remove element
            element_name = None
            new_elements = []
            for el in canvas_data.get("elements", []):
                if el["id"] == element_id:
                    element_name = el["name"]
                else:
                    new_elements.append(el)

            if element_name is None:
                return self.fail_response(f"Element '{element_id}' not found in canvas")

            canvas_data["elements"] = new_elements

            # Save canvas
            await self._save_canvas_data(canvas_path, canvas_data)

            result = {
                "canvas_path": canvas_path,
                "removed_element_id": element_id,
                "removed_element_name": element_name,
                "remaining_elements": len(new_elements),
                "sandbox_id": self.sandbox_id,
                "message": f"Removed element '{element_name}' from canvas"
            }

            return self.success_response(result)

        except Exception as e:
            return self.fail_response(f"Failed to remove element: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "ai_process_canvas_element",
            "description": "Apply AI processing (upscale or remove background) to an image element on the canvas. The processed result is added as a NEW element next to the original. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `canvas_path` (REQUIRED), `element_id` (REQUIRED), `action` (REQUIRED: 'upscale' or 'remove_bg').",
            "parameters": {
                "type": "object",
                "properties": {
                    "canvas_path": {
                        "type": "string",
                        "description": "**REQUIRED** - Path to the canvas file. Example: 'canvases/project-mockup.kanvax'"
                    },
                    "element_id": {
                        "type": "string",
                        "description": "**REQUIRED** - ID of the image element to process. Get this from list_canvas_elements."
                    },
                    "action": {
                        "type": "string",
                        "enum": ["upscale", "remove_bg"],
                        "description": "**REQUIRED** - Action to perform: 'upscale' (enhance resolution) or 'remove_bg' (remove background)."
                    }
                },
                "required": ["canvas_path", "element_id", "action"],
                "additionalProperties": False
            }
        }
    })
    async def ai_process_canvas_element(
        self,
        canvas_path: str,
        element_id: str,
        action: Literal["upscale", "remove_bg"]
    ) -> ToolResult:
        """
        Apply AI processing to a canvas element.
        
        1. Finds the element in the canvas
        2. Gets its image data
        3. Processes with AI (upscale or remove_bg)
        4. Saves result as new file
        5. Adds new element to canvas next to original
        """
        # Normalize path
        canvas_path = self._normalize_path(canvas_path)
        
        try:
            await self._ensure_sandbox()
            
            # Validate action
            if action not in ("upscale", "remove_bg"):
                return self.fail_response(f"Invalid action '{action}'. Use 'upscale' or 'remove_bg'.")
            
            # Load canvas
            canvas_data = await self._load_canvas_data(canvas_path)
            if not canvas_data:
                return self.fail_response(f"Canvas not found: {canvas_path}")
            
            # Find the element
            source_element = None
            for el in canvas_data.get("elements", []):
                if el["id"] == element_id:
                    source_element = el
                    break
            
            if not source_element:
                return self.fail_response(f"Element '{element_id}' not found in canvas")
            
            if source_element.get("type") != "image":
                return self.fail_response(f"Element '{element_id}' is not an image (type: {source_element.get('type')})")
            
            # Get the image source
            src = source_element.get("src", "")
            if not src:
                return self.fail_response(f"Element '{element_id}' has no image source")
            
            # Get image bytes
            if src.startswith("data:"):
                # Base64 embedded image
                import base64
                try:
                    # Parse data URL: data:image/png;base64,xxxxx
                    header, data = src.split(',', 1)
                    mime_type = header.split(':')[1].split(';')[0]
                    image_bytes = base64.b64decode(data)
                except Exception as e:
                    return self.fail_response(f"Failed to decode embedded image: {str(e)}")
            else:
                # File path reference
                image_full_path = f"{self.workspace_path}/{src}"
                try:
                    image_bytes = await self.sandbox.fs.download_file(image_full_path)
                    # Determine mime type from extension
                    if src.lower().endswith(".jpg") or src.lower().endswith(".jpeg"):
                        mime_type = "image/jpeg"
                    elif src.lower().endswith(".webp"):
                        mime_type = "image/webp"
                    else:
                        mime_type = "image/png"
                except Exception as e:
                    return self.fail_response(f"Failed to read image from '{src}': {str(e)}")
            
            # BILLING: Check credits before processing
            account_id = getattr(self, '_account_id', None) or getattr(self, 'account_id', None)
            if not account_id:
                account_id = getattr(self.thread_manager, 'account_id', None)
            
            use_mock = os.getenv("MOCK_IMAGE_GENERATION", "false").lower() == "true"
            
            if account_id and not use_mock:
                has_credits, credit_msg, balance = await media_billing.check_credits(account_id)
                if not has_credits:
                    return self.fail_response(f"Insufficient credits: {credit_msg}")
            
            # Process the image
            logger.info(f"[Canvas AI] Processing element '{source_element.get('name', element_id)}' with action '{action}'")
            
            try:
                loop = asyncio.get_event_loop()
                if action == "upscale":
                    result_bytes, result_mime = await loop.run_in_executor(
                        None, upscale_image_sync, image_bytes, mime_type
                    )
                    output_ext = "webp"
                    billing_model = UPSCALE_MODEL
                else:  # remove_bg
                    result_bytes, result_mime = await loop.run_in_executor(
                        None, remove_background_sync, image_bytes, mime_type
                    )
                    output_ext = "png"
                    billing_model = REMOVE_BG_MODEL
            except Exception as e:
                return self.fail_response(f"AI processing failed: {str(e)}")
            
            # BILLING: Deduct credits for successful processing
            if account_id and not use_mock:
                await media_billing.deduct_replicate_image(
                    account_id=account_id,
                    model=billing_model,
                    count=1,
                    description=f"Canvas {action}",
                )
            
            # Save result to images directory
            await self._ensure_images_dir()
            action_prefix = "upscaled" if action == "upscale" else "nobg"
            result_filename = f"{action_prefix}_{uuid.uuid4().hex[:8]}.{output_ext}"
            result_path = f"{self.images_dir}/{result_filename}"
            full_result_path = f"{self.workspace_path}/{result_path}"
            await self.sandbox.fs.upload_file(result_bytes, full_result_path)
            
            # Get dimensions of result image
            try:
                img = Image.open(io.BytesIO(result_bytes))
                result_width, result_height = img.size
                img.close()
            except:
                result_width = source_element.get("width", 400)
                result_height = source_element.get("height", 400)
            
            # Calculate position for new element (to the right of original)
            new_x = source_element.get("x", 100) + source_element.get("width", 400) + 50
            new_y = source_element.get("y", 100)
            
            # Use actual result size (no cap - canvas is infinite)
            elem_width = result_width
            elem_height = result_height
            
            # Create new element
            new_element_id = str(uuid.uuid4())
            action_label = "Upscaled" if action == "upscale" else "No BG"
            original_name = source_element.get("name", "image")
            new_element = {
                "id": new_element_id,
                "type": "image",
                "src": result_path,
                "x": new_x,
                "y": new_y,
                "width": elem_width,
                "height": elem_height,
                "rotation": 0,
                "scaleX": 1,
                "scaleY": 1,
                "opacity": 1,
                "locked": False,
                "name": f"{action_label} - {original_name}"
            }
            
            # Add to canvas
            canvas_data["elements"].append(new_element)
            await self._save_canvas_data(canvas_path, canvas_data)
            
            result = {
                "canvas_path": canvas_path,
                "source_element_id": element_id,
                "source_element_name": source_element.get("name", element_id),
                "new_element_id": new_element_id,
                "new_element_name": new_element["name"],
                "action": action,
                "result_path": result_path,
                "position": {"x": new_x, "y": new_y},
                "size": {"width": elem_width, "height": elem_height},
                "total_elements": len(canvas_data["elements"]),
                "sandbox_id": self.sandbox_id,
                "message": f"Applied '{action}' to '{original_name}' and added result to canvas"
            }
            
            return self.success_response(result)
            
        except Exception as e:
            return self.fail_response(f"Failed to process canvas element: {str(e)}")

