from typing import Optional, Dict, Any, List
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
import json
import uuid
from datetime import datetime


@tool_metadata(
    display_name="Canvas Editor",
    description="Create and manage interactive canvases for image composition and design",
    icon="Layout",
    color="bg-blue-100 dark:bg-blue-800/50",
    weight=215,
    visible=True,
    usage_guide="""
### CANVAS EDITOR WORKFLOW

**Creating a Canvas:**
1. `create_canvas(name="project-mockup", width=1920, height=1080)` - Initialize new canvas
2. Canvas opens automatically in suite mode for maximum working space

**Adding Images:**
1. Use `designer_create_or_edit()` to generate images
2. Use `add_image_to_canvas()` to place images on canvas
3. User can then move, scale, rotate interactively

**Canvas Features:**
- Drag images to reposition
- Scale and rotate with transform handles
- Layer management (bring forward/send back)
- Grid and snap-to-grid
- Lock elements to prevent accidental changes
- Properties panel for precise control

**File Format:**
- Canvases are saved as `.kanvax` files
- JSON format internally for easy parsing
- Stores all element positions, sizes, and properties

**Best Practices:**
- Start with appropriate canvas dimensions for the use case
- Add descriptive names to canvas elements
- Use the designer tool to generate high-quality images first
- Lock elements when composition is finalized
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

    async def _ensure_canvases_dir(self):
        """Ensure the canvases directory exists"""
        full_path = f"{self.workspace_path}/{self.canvases_dir}"
        try:
            await self.sandbox.fs.create_folder(full_path, "755")
        except:
            pass

    async def _ensure_images_dir(self):
        """Ensure the images directory exists"""
        full_path = f"{self.workspace_path}/{self.images_dir}"
        try:
            await self.sandbox.fs.create_folder(full_path, "755")
        except:
            pass

    def _sanitize_filename(self, name: str) -> str:
        """Convert canvas name to safe filename"""
        return "".join(c for c in name if c.isalnum() or c in "-_").lower()

    def _create_canvas_data(
        self, 
        name: str, 
        width: int, 
        height: int, 
        description: Optional[str] = None,
        background: str = "#ffffff"
    ) -> Dict[str, Any]:
        """Create initial canvas data structure"""
        now = datetime.utcnow().isoformat() + "Z"
        return {
            "name": name,
            "version": "1.0",
            "width": width,
            "height": height,
            "background": background,
            "description": description or "",
            "elements": [],
            "created_at": now,
            "updated_at": now
        }

    async def _load_canvas_data(self, canvas_path: str) -> Dict[str, Any]:
        """Load canvas data from .kanvax file"""
        try:
            content = await self.sandbox.fs.read_file(f"{self.workspace_path}/{canvas_path}")
            return json.loads(content)
        except Exception as e:
            raise Exception(f"Failed to load canvas: {str(e)}")

    async def _save_canvas_data(self, canvas_path: str, canvas_data: Dict[str, Any]):
        """Save canvas data to .kanvax file"""
        try:
            canvas_data["updated_at"] = datetime.utcnow().isoformat() + "Z"
            content = json.dumps(canvas_data, indent=2)
            await self.sandbox.fs.write_file(
                f"{self.workspace_path}/{canvas_path}",
                content,
                "644"
            )
        except Exception as e:
            raise Exception(f"Failed to save canvas: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_canvas",
            "description": "Create a new interactive canvas for image composition and design. Canvas opens in suite mode for maximum working space.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Name for the canvas (will be sanitized for filename). Use descriptive names like 'product-mockup' or 'social-media-banner'."
                    },
                    "width": {
                        "type": "integer",
                        "description": "Canvas width in pixels. Common sizes: 1920 (desktop), 1080 (square), 1200 (portrait). Range: 256-4096px",
                        "minimum": 256,
                        "maximum": 4096,
                        "default": 1920
                    },
                    "height": {
                        "type": "integer",
                        "description": "Canvas height in pixels. Common sizes: 1080 (desktop), 1920 (portrait), 1200 (square). Range: 256-4096px",
                        "minimum": 256,
                        "maximum": 4096,
                        "default": 1080
                    },
                    "description": {
                        "type": "string",
                        "description": "Optional description of the canvas purpose or content"
                    },
                    "background": {
                        "type": "string",
                        "description": "Background color in hex format (e.g., '#ffffff' for white, '#f0f0f0' for light gray)",
                        "default": "#ffffff"
                    }
                },
                "required": ["name"]
            }
        }
    })
    async def create_canvas(
        self,
        name: str,
        width: int = 1920,
        height: int = 1080,
        description: Optional[str] = None,
        background: str = "#ffffff"
    ) -> ToolResult:
        """Create a new canvas with specified dimensions"""
        try:
            await self._ensure_canvases_dir()
            await self._ensure_images_dir()

            safe_name = self._sanitize_filename(name)
            canvas_path = f"{self.canvases_dir}/{safe_name}.kanvax"
            full_path = f"{self.workspace_path}/{canvas_path}"

            # Check if canvas already exists
            try:
                await self.sandbox.fs.read_file(full_path)
                return self.fail_response(f"Canvas '{name}' already exists at {canvas_path}")
            except:
                pass  # File doesn't exist, continue

            # Create canvas data
            canvas_data = self._create_canvas_data(name, width, height, description, background)

            # Save canvas file
            await self._save_canvas_data(canvas_path, canvas_data)

            result = {
                "canvas_name": name,
                "canvas_path": canvas_path,
                "width": width,
                "height": height,
                "background": background,
                "description": description or "",
                "message": f"Canvas '{name}' created successfully at {canvas_path}"
            }

            return self.success_response(
                message=f"Created canvas '{name}' ({width}x{height}px) at {canvas_path}",
                data=result
            )

        except Exception as e:
            return self.fail_response(f"Failed to create canvas: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "add_image_to_canvas",
            "description": "Add an image element to an existing canvas. Image can be from designs folder or any workspace path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "canvas_path": {
                        "type": "string",
                        "description": "Path to the canvas file (e.g., 'canvases/project-mockup.kanvax')"
                    },
                    "image_path": {
                        "type": "string",
                        "description": "Path to the image file relative to workspace (e.g., 'designs/logo.png')"
                    },
                    "x": {
                        "type": "number",
                        "description": "X position on canvas in pixels",
                        "default": 100
                    },
                    "y": {
                        "type": "number",
                        "description": "Y position on canvas in pixels",
                        "default": 100
                    },
                    "width": {
                        "type": "number",
                        "description": "Width of the image in pixels (optional, uses original size if not specified)",
                        "minimum": 1
                    },
                    "height": {
                        "type": "number",
                        "description": "Height of the image in pixels (optional, uses original size if not specified)",
                        "minimum": 1
                    },
                    "name": {
                        "type": "string",
                        "description": "Optional name for the element (defaults to image filename)"
                    }
                },
                "required": ["canvas_path", "image_path"]
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
        try:
            # Load canvas data
            canvas_data = await self._load_canvas_data(canvas_path)

            # Verify image exists
            image_full_path = f"{self.workspace_path}/{image_path}"
            try:
                await self.sandbox.fs.read_file(image_full_path)
            except:
                return self.fail_response(f"Image not found at {image_path}")

            # Create element
            element_id = str(uuid.uuid4())
            element_name = name or image_path.split('/')[-1]

            element = {
                "id": element_id,
                "type": "image",
                "src": image_path,
                "x": x,
                "y": y,
                "width": width or 400,  # Default width if not specified
                "height": height or 400,  # Default height if not specified
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
                "position": {"x": x, "y": y},
                "size": {"width": element["width"], "height": element["height"]},
                "total_elements": len(canvas_data["elements"]),
                "message": f"Added '{element_name}' to canvas at position ({x}, {y})"
            }

            return self.success_response(
                message=f"Added image '{element_name}' to canvas",
                data=result
            )

        except Exception as e:
            return self.fail_response(f"Failed to add image to canvas: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_canvas_elements",
            "description": "List all elements in a canvas with their properties",
            "parameters": {
                "type": "object",
                "properties": {
                    "canvas_path": {
                        "type": "string",
                        "description": "Path to the canvas file (e.g., 'canvases/project-mockup.kanvax')"
                    }
                },
                "required": ["canvas_path"]
            }
        }
    })
    async def list_canvas_elements(self, canvas_path: str) -> ToolResult:
        """List all elements in a canvas"""
        try:
            canvas_data = await self._load_canvas_data(canvas_path)

            elements_info = []
            for element in canvas_data["elements"]:
                elements_info.append({
                    "id": element["id"],
                    "name": element["name"],
                    "type": element["type"],
                    "src": element["src"],
                    "position": {"x": element["x"], "y": element["y"]},
                    "size": {"width": element["width"], "height": element["height"]},
                    "rotation": element["rotation"],
                    "opacity": element["opacity"],
                    "locked": element["locked"]
                })

            result = {
                "canvas_name": canvas_data["name"],
                "canvas_path": canvas_path,
                "canvas_size": {"width": canvas_data["width"], "height": canvas_data["height"]},
                "background": canvas_data["background"],
                "total_elements": len(elements_info),
                "elements": elements_info
            }

            return self.success_response(
                message=f"Canvas '{canvas_data['name']}' has {len(elements_info)} element(s)",
                data=result
            )

        except Exception as e:
            return self.fail_response(f"Failed to list canvas elements: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "update_canvas_element",
            "description": "Update properties of a canvas element (position, size, rotation, etc.)",
            "parameters": {
                "type": "object",
                "properties": {
                    "canvas_path": {
                        "type": "string",
                        "description": "Path to the canvas file"
                    },
                    "element_id": {
                        "type": "string",
                        "description": "ID of the element to update"
                    },
                    "x": {"type": "number", "description": "New X position"},
                    "y": {"type": "number", "description": "New Y position"},
                    "width": {"type": "number", "description": "New width"},
                    "height": {"type": "number", "description": "New height"},
                    "rotation": {"type": "number", "description": "Rotation in degrees"},
                    "opacity": {"type": "number", "description": "Opacity (0-1)", "minimum": 0, "maximum": 1},
                    "locked": {"type": "boolean", "description": "Lock element to prevent changes"},
                    "name": {"type": "string", "description": "Element name"}
                },
                "required": ["canvas_path", "element_id"]
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
            canvas_data = await self._load_canvas_data(canvas_path)

            # Find element
            element = None
            for el in canvas_data["elements"]:
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
                "message": f"Updated element '{element['name']}' ({len(updated_props)} properties)"
            }

            return self.success_response(
                message=f"Updated element '{element['name']}'",
                data=result
            )

        except Exception as e:
            return self.fail_response(f"Failed to update element: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "remove_canvas_element",
            "description": "Remove an element from the canvas",
            "parameters": {
                "type": "object",
                "properties": {
                    "canvas_path": {
                        "type": "string",
                        "description": "Path to the canvas file"
                    },
                    "element_id": {
                        "type": "string",
                        "description": "ID of the element to remove"
                    }
                },
                "required": ["canvas_path", "element_id"]
            }
        }
    })
    async def remove_canvas_element(self, canvas_path: str, element_id: str) -> ToolResult:
        """Remove an element from the canvas"""
        try:
            canvas_data = await self._load_canvas_data(canvas_path)

            # Find and remove element
            element_name = None
            new_elements = []
            for el in canvas_data["elements"]:
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
                "message": f"Removed element '{element_name}' from canvas"
            }

            return self.success_response(
                message=f"Removed element '{element_name}' from canvas",
                data=result
            )

        except Exception as e:
            return self.fail_response(f"Failed to remove element: {str(e)}")

