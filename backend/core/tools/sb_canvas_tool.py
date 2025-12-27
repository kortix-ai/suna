from typing import Optional, Dict, Any, List
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
import json
import uuid
import asyncio
import io
from datetime import datetime
from PIL import Image

# Global lock for canvas file operations to prevent race conditions
_canvas_locks: Dict[str, asyncio.Lock] = {}


@tool_metadata(
    display_name="Canvas Editor",
    description="Create and manage interactive canvases for image composition and design",
    icon="Layout",
    color="bg-blue-100 dark:bg-blue-800/50",
    weight=215,
    visible=True,
    usage_guide="""
### CANVAS EDITOR

**🚀 PREFERRED WORKFLOW: Use image_edit_or_generate with canvas_path**
```python
# BEST: Single call generates AND adds to canvas (auto-creates canvas if needed)
image_edit_or_generate(
    mode="generate",
    prompt=["logo design", "background pattern", "icon set"],
    canvas_path="canvases/my-design.kanvax"
)
# This: generates 3 images, creates canvas if needed, adds all images automatically
```

**📦 MANUAL WORKFLOW (backup/advanced control):**
Use these tools when you need fine control over canvas or element positioning:

```python
# 1. Create canvas manually
create_canvas(name="my-design", background="#1a1a1a")

# 2. Add images one at a time (NEVER parallel!)
add_image_to_canvas(canvas_path="canvases/my-design.kanvax", image_path="image.png", x=100, y=100)
```

**⚠️ MANUAL WORKFLOW RULES:**
- NEVER call add_image_to_canvas in PARALLEL - causes race conditions!
- Call ONE AT A TIME, wait for each to complete
- Use EXACT filenames returned from image generation
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
            content = await self.sandbox.fs.download_file(f"{self.workspace_path}/{canvas_path}")
            return json.loads(content.decode() if isinstance(content, bytes) else content)
        except Exception as e:
            return None

    async def _save_canvas_data(self, canvas_path: str, canvas_data: Dict[str, Any]):
        """Save canvas data to .kanvax file"""
        try:
            await self._ensure_sandbox()
            await self._ensure_canvases_dir()  # Ensure directory exists!
            
            canvas_data["updated_at"] = datetime.utcnow().isoformat() + "Z"
            content = json.dumps(canvas_data, indent=2)
            full_path = f"{self.workspace_path}/{canvas_path}"
            
            logger.debug(f"[Canvas] Saving canvas to: {full_path} in sandbox {self._sandbox_id}")
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
            "description": "Save canvas data with all elements. Used to persist user changes from the canvas editor. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `canvas_path` (REQUIRED), `elements` (REQUIRED).",
            "parameters": {
                "type": "object",
                "properties": {
                    "canvas_path": {
                        "type": "string",
                        "description": "**REQUIRED** - Path to the canvas file. Example: 'canvases/project-mockup.kanvax'"
                    },
                    "elements": {
                        "type": "array",
                        "description": "**REQUIRED** - Array of canvas elements with their properties (id, type, src, x, y, width, height, rotation, scaleX, scaleY, opacity, locked, name).",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "type": {"type": "string"},
                                "src": {"type": "string"},
                                "x": {"type": "number"},
                                "y": {"type": "number"},
                                "width": {"type": "number"},
                                "height": {"type": "number"},
                                "rotation": {"type": "number"},
                                "scaleX": {"type": "number"},
                                "scaleY": {"type": "number"},
                                "opacity": {"type": "number"},
                                "locked": {"type": "boolean"},
                                "name": {"type": "string"}
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
            "description": "Add an image element to an existing canvas. Image can be from designs folder or any workspace path. **⚠️ IMPORTANT**: NEVER call this function in parallel - causes race conditions! Call ONE AT A TIME. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `canvas_path` (REQUIRED), `image_path` (REQUIRED), `x` (optional), `y` (optional), `width` (optional), `height` (optional), `name` (optional).",
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
                        "description": "**OPTIONAL** - X position on canvas in pixels. Default: 100.",
                        "default": 100
                    },
                    "y": {
                        "type": "number",
                        "description": "**OPTIONAL** - Y position on canvas in pixels. Default: 100.",
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
        name: Optional[str] = None
    ) -> ToolResult:
        """Add an image element to the canvas"""
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
                    # No size specified - use actual image size, capped
                    max_size = 600
                    if actual_img_width > max_size or actual_img_height > max_size:
                        if actual_img_width > actual_img_height:
                            elem_width = max_size
                            elem_height = max_size / aspect_ratio
                        else:
                            elem_height = max_size
                            elem_width = max_size * aspect_ratio
                    else:
                        elem_width = actual_img_width
                        elem_height = actual_img_height
                
                # Auto-calculate position if not specified (x=100 and y=100 are defaults)
                # Create a grid layout based on existing elements
                actual_x = x
                actual_y = y
                if x == 100 and y == 100 and len(canvas_data["elements"]) > 0:
                    # Calculate next position in grid
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
        try:
            await self._ensure_sandbox()
            canvas_data = await self._load_canvas_data(canvas_path)
            
            if not canvas_data:
                return self.fail_response(f"Canvas not found: {canvas_path}")

            elements_info = []
            for element in canvas_data.get("elements", []):
                # Get src info but NEVER include base64 data in tool results (LLM context bloat)
                src = element.get("src", "")
                if src.startswith("data:"):
                    # Base64 embedded - just indicate it exists
                    src_info = "(embedded image)"
                else:
                    # File path reference - safe to include
                    src_info = src
                
                elements_info.append({
                    "id": element["id"],
                    "name": element["name"],
                    "type": element["type"],
                    "src": src_info,  # Path or indicator, NEVER base64 data
                    "position": {"x": element["x"], "y": element["y"]},
                    "size": {"width": element["width"], "height": element["height"]},
                    "rotation": element.get("rotation", 0),
                    "opacity": element.get("opacity", 1),
                    "locked": element.get("locked", False)
                })

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

