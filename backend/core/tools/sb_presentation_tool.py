from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from typing import List, Dict, Optional, Union
import json
import os
from datetime import datetime
import re
import asyncio

@tool_metadata(
    display_name="Presentations",
    description="Create and manage stunning presentation slides",
    icon="Presentation",
    color="bg-orange-100 dark:bg-orange-800/50",
    weight=70,
    visible=True
)
class SandboxPresentationTool(SandboxToolsBase):
    """
    Per-slide HTML presentation tool for creating presentation slides.
    Each slide is created as a basic HTML document without predefined CSS styling.
    Users can include their own CSS styling inline or in style tags as needed.
    """
    
    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.presentations_dir = "presentations"
        # Path to built-in templates (on the backend filesystem, not in sandbox)
        self.templates_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "templates", "presentations")


    async def _ensure_presentations_dir(self):
        """Ensure the presentations directory exists"""
        full_path = f"{self.workspace_path}/{self.presentations_dir}"
        try:
            await self.sandbox.fs.create_folder(full_path, "755")
        except:
            pass

    async def _ensure_presentation_dir(self, presentation_name: str):
        """Ensure a specific presentation directory exists"""
        safe_name = self._sanitize_filename(presentation_name)
        presentation_path = f"{self.workspace_path}/{self.presentations_dir}/{safe_name}"
        try:
            await self.sandbox.fs.create_folder(presentation_path, "755")
        except:
            pass
        return safe_name, presentation_path

    def _sanitize_filename(self, name: str) -> str:
        """Convert presentation name to safe filename"""
        return "".join(c for c in name if c.isalnum() or c in "-_").lower()


    def _create_slide_html(self, slide_content: str, slide_number: int, total_slides: int, presentation_title: str) -> str:
        """Create a basic HTML document without predefined CSS"""
        
        html_template = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{presentation_title} - Slide {slide_number}</title>
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/chart.js@3.9.1"></script>
    <style>
        body {{
            height: 1080px;
            width: 1920px;
            margin: 0;
            padding: 0;
        }}
    </style>
</head>
<body>
    {slide_content}
</body>
</html>"""
        return html_template

    async def _load_presentation_metadata(self, presentation_path: str):
        """Load presentation metadata, create if doesn't exist"""
        metadata_path = f"{presentation_path}/metadata.json"
        try:
            metadata_content = await self.sandbox.fs.download_file(metadata_path)
            return json.loads(metadata_content.decode())
        except:
            # Create default metadata
            return {
                "presentation_name": "",
                "title": "Presentation", 
                "description": "",
                "slides": {},
                "created_at": datetime.now().isoformat(),
                "updated_at": datetime.now().isoformat()
            }

    async def _save_presentation_metadata(self, presentation_path: str, metadata: Dict):
        """Save presentation metadata"""
        metadata["updated_at"] = datetime.now().isoformat()
        metadata_path = f"{presentation_path}/metadata.json"
        await self.sandbox.fs.upload_file(json.dumps(metadata, indent=2).encode(), metadata_path)

    def _load_template_metadata(self, template_name: str) -> Dict:
        """Load metadata from a template on the backend filesystem"""
        metadata_path = os.path.join(self.templates_dir, template_name, "metadata.json")
        try:
            with open(metadata_path, 'r') as f:
                return json.load(f)
        except Exception as e:
            return {}

    def _read_template_slide(self, template_name: str, slide_filename: str) -> str:
        """Read a slide HTML file from a template"""
        slide_path = os.path.join(self.templates_dir, template_name, slide_filename)
        try:
            with open(slide_path, 'r') as f:
                return f.read()
        except Exception as e:
            return ""

    def _extract_style_from_html(self, html_content: str) -> Dict:
        """Extract CSS styles and design patterns from HTML content"""
        style_info = {
            "fonts": [],
            "colors": [],
            "layout_patterns": [],
            "key_css_classes": []
        }
        
        # Extract font imports
        font_imports = re.findall(r'@import url\([\'"]([^\'"]+)[\'"]', html_content)
        font_families = re.findall(r'font-family:\s*[\'"]?([^;\'"]+)[\'"]?', html_content)
        style_info["fonts"] = list(set(font_imports + font_families))
        
        # Extract color values (hex, rgb, rgba)
        hex_colors = re.findall(r'#[0-9A-Fa-f]{3,6}', html_content)
        rgb_colors = re.findall(r'rgba?\([^)]+\)', html_content)
        style_info["colors"] = list(set(hex_colors + rgb_colors))[:20]  # Limit to top 20
        
        # Extract class names
        class_names = re.findall(r'class=[\'"]([^\'"]+)[\'"]', html_content)
        style_info["key_css_classes"] = list(set(class_names))[:30]
        
        # Identify layout patterns
        if 'display: flex' in html_content or 'display:flex' in html_content:
            style_info["layout_patterns"].append("flexbox")
        if 'display: grid' in html_content or 'display:grid' in html_content:
            style_info["layout_patterns"].append("grid")
        if 'position: absolute' in html_content:
            style_info["layout_patterns"].append("absolute positioning")
        
        return style_info


    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_templates",
            "description": "List all available presentation template names with their metadata and preview images. Use this to see what template styles are available, then use load_template_design to get the full design reference for a specific template.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    async def list_templates(self) -> ToolResult:
        """List all available presentation templates with metadata and images"""
        try:
            templates = []
            
            # Check if templates directory exists
            if not os.path.exists(self.templates_dir):
                return self.success_response({
                    "message": "No templates directory found",
                    "templates": []
                })
            
            # List all subdirectories in templates folder
            for item in os.listdir(self.templates_dir):
                template_path = os.path.join(self.templates_dir, item)
                if os.path.isdir(template_path) and not item.startswith('.'):
                    # Load metadata for this template
                    metadata = self._load_template_metadata(item)
                    
                    # Check if image.png exists
                    image_path = os.path.join(template_path, "image.png")
                    has_image = os.path.exists(image_path)
                    
                    template_info = {
                        "id": item,
                        "name": item,  # Use folder name directly
                        "has_image": has_image
                    }
                    templates.append(template_info)
            
            if not templates:
                return self.success_response({
                    "message": "No templates found",
                    "templates": []
                })
            
            # Sort templates by name
            templates.sort(key=lambda x: x["name"])
            
            return self.success_response({
                "message": f"Found {len(templates)} template(s)",
                "templates": templates,
                "note": "Use load_template_design with a template id to get the complete design reference"
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to list templates: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "load_template_design",
            "description": "Load complete design reference from a presentation template including all slide HTML and extracted style patterns (colors, fonts, layouts). Use this template as DESIGN INSPIRATION ONLY - study the visual styling, CSS patterns, and layout structure to create your own original slides with similar aesthetics but completely different content. CRITICAL: Templates are for design reference only, never copy content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "template_name": {
                        "type": "string",
                        "description": "Name of the template to load (e.g., 'textbook')"
                    }
                },
                "required": ["template_name"]
            }
        }
    })
    async def load_template_design(self, template_name: str) -> ToolResult:
        """Load complete template design including all slides HTML and extracted style patterns"""
        try:
            template_path = os.path.join(self.templates_dir, template_name)
            
            if not os.path.exists(template_path):
                return self.fail_response(f"Template '{template_name}' not found")
            
            # Load template metadata
            metadata = self._load_template_metadata(template_name)
            
            if not metadata or "slides" not in metadata:
                return self.fail_response(f"Template '{template_name}' has no metadata or slides")
            
            # Extract all slides HTML
            slides = []
            all_fonts = set()
            all_colors = set()
            all_layout_patterns = set()
            all_css_classes = set()
            
            for slide_num, slide_data in sorted(metadata["slides"].items(), key=lambda x: int(x[0])):
                slide_filename = slide_data.get("filename", f"slide_{int(slide_num):02d}.html")
                html_content = self._read_template_slide(template_name, slide_filename)
                
                if html_content:
                    # Add slide info
                    slides.append({
                        "slide_number": int(slide_num),
                        "title": slide_data.get("title", f"Slide {slide_num}"),
                        "filename": slide_filename,
                        "html_content": html_content,
                        "html_length": len(html_content)
                    })
                    
                    # Extract style information from this slide
                    style_info = self._extract_style_from_html(html_content)
                    all_fonts.update(style_info["fonts"])
                    all_colors.update(style_info["colors"])
                    all_layout_patterns.update(style_info["layout_patterns"])
                    all_css_classes.update(style_info["key_css_classes"])
            
            if not slides:
                return self.fail_response(f"Could not load any slides from template '{template_name}'")
            
            return self.success_response({
                "template_name": template_name,
                "template_title": metadata.get("title", template_name),
                "description": metadata.get("description", ""),
                "total_slides": len(slides),
                "slides": slides,
                "design_system": {
                    "fonts": list(all_fonts)[:10],  # Top 10 fonts
                    "color_palette": list(all_colors)[:20],  # Top 20 colors
                    "layout_patterns": list(all_layout_patterns),
                    "common_css_classes": list(all_css_classes)[:30]  # Top 30 classes
                },
                "usage_instructions": {
                    "purpose": "DESIGN REFERENCE ONLY - Use for visual inspiration",
                    "do": [
                        "Study the HTML structure and CSS styling patterns",
                        "Learn the layout techniques and visual hierarchy",
                        "Understand the color scheme and typography usage",
                        "Analyze how elements are positioned and styled",
                        "Create NEW slides with similar design but ORIGINAL content"
                    ],
                    "dont": [
                        "Copy template content directly",
                        "Use template text, data, or information",
                        "Duplicate slides without modification",
                        "Treat templates as final deliverables"
                    ]
                },
                "note": "This template provides ALL slides and extracted design patterns in one response. Study the HTML and CSS to understand the design system, then create your own original slides with similar visual styling."
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to load template design: {str(e)}")


    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_slide",
            "description": "Create or update a single slide in a presentation. Each slide is saved as a standalone HTML file with 1920x1080 dimensions (16:9 aspect ratio). Perfect for iterative slide creation and editing.",
            "parameters": {
                "type": "object",
                "properties": {
                    "presentation_name": {
                        "type": "string",
                        "description": "Name of the presentation (creates folder if doesn't exist)"
                    },
                    "slide_number": {
                        "type": "integer",
                        "description": "Slide number (1-based). If slide exists, it will be updated."
                    },
                    "slide_title": {
                        "type": "string",
                        "description": "Title of this specific slide (for reference and navigation)"
                    },
                    "content": {
                        "type": "string",
                        "description": """HTML body content only (DO NOT include <!DOCTYPE>, <html>, <head>, or <body> tags - these are added automatically). Include your content with inline CSS or <style> blocks. Design for 1920x1080 resolution. D3.js, Font Awesome, and Chart.js are pre-loaded and available to use.
                        
                        ## 📐 **Design and Layout Rules**

                        ### **Dimensions & Spacing**
                        *   **Slide Size**: 1920x1080 pixels (16:9)
                        *   **Padding**: 80px on all edges (minimum 60px)
                        *   **Section Gaps**: 40-60px between major sections  
                        *   **Element Gaps**: 20-30px between related items
                        *   **List Spacing**: Use `gap: 25px` in flex/grid layouts
                        *   **Line Height**: 1.5-1.8 for readability

                        ### **Typography**
                        Use `font_family` from **Theme Object**:
                        *   **Titles**: 48-72px (bold)
                        *   **Subtitles**: 32-42px (semi-bold)  
                        *   **Headings**: 28-36px (semi-bold)
                        *   **Body**: 20-24px (normal)
                        *   **Small**: 16-18px (light)

                        ### **Color Usage**
                        Use ONLY **Theme Object** colors:
                        *   **Primary**: Backgrounds, main elements
                        *   **Secondary**: Subtle backgrounds
                        *   **Accent**: Highlights, CTAs
                        *   **Text**: All text content

                        ### **Layout Principles**
                        *   Focus on 1-2 main ideas per slide
                        *   Limit to 3-5 bullet points max
                        *   Use `overflow: hidden` on containers
                        *   Grid columns: Use `gap: 50-60px`
                        *   Embrace whitespace - don't fill every pixel
                        """
                    },
                    "presentation_title": {
                                    "type": "string",
                        "description": "Main title of the presentation (used in HTML title and navigation)",
                        "default": "Presentation"
                    }
                },
                "required": ["presentation_name", "slide_number", "slide_title", "content"]
            }
        }
    })
    async def create_slide(
        self,
        presentation_name: str,
        slide_number: int,
        slide_title: str,
        content: str,
        presentation_title: str = "Presentation"
    ) -> ToolResult:
        """Create or update a single slide in a presentation"""
        try:
            await self._ensure_sandbox()
            await self._ensure_presentations_dir()
            
            # Validation
            if not presentation_name:
                return self.fail_response("Presentation name is required.")
            
            if slide_number < 1:
                return self.fail_response("Slide number must be 1 or greater.")
            
            if not slide_title:
                return self.fail_response("Slide title is required.")
            
            if not content:
                return self.fail_response("Slide content is required.")
            
            # Ensure presentation directory exists
            safe_name, presentation_path = await self._ensure_presentation_dir(presentation_name)
            
            # Load or create metadata
            metadata = await self._load_presentation_metadata(presentation_path)
            metadata["presentation_name"] = presentation_name
            if presentation_title != "Presentation":  # Only update if explicitly provided
                metadata["title"] = presentation_title
            
            # Create slide HTML
            slide_html = self._create_slide_html(
                slide_content=content,
                slide_number=slide_number,
                total_slides=0,  # Will be updated when regenerating navigation
                presentation_title=presentation_title
            )
            
            # Save slide file
            slide_filename = f"slide_{slide_number:02d}.html"
            slide_path = f"{presentation_path}/{slide_filename}"
            await self.sandbox.fs.upload_file(slide_html.encode(), slide_path)
            
            # Update metadata
            if "slides" not in metadata:
                metadata["slides"] = {}
            
            metadata["slides"][str(slide_number)] = {
                "title": slide_title,
                "filename": slide_filename,
                "file_path": f"{self.presentations_dir}/{safe_name}/{slide_filename}",
                "preview_url": f"/workspace/{self.presentations_dir}/{safe_name}/{slide_filename}",
                "created_at": datetime.now().isoformat()
            }
            
            # Save updated metadata
            await self._save_presentation_metadata(presentation_path, metadata)
            
            return self.success_response({
                "message": f"Slide {slide_number} '{slide_title}' created/updated successfully",
                "presentation_name": presentation_name,
                "presentation_path": f"{self.presentations_dir}/{safe_name}",
                "slide_number": slide_number,
                "slide_title": slide_title,
                "slide_file": f"{self.presentations_dir}/{safe_name}/{slide_filename}",
                "preview_url": f"/workspace/{self.presentations_dir}/{safe_name}/{slide_filename}",
                "total_slides": len(metadata["slides"]),
                "note": "Professional slide created with custom styling - designed for 1920x1080 resolution"
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to create slide: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_slides",
            "description": "List all slides in a presentation, showing their titles and order",
            "parameters": {
                "type": "object",
                "properties": {
                    "presentation_name": {
                        "type": "string",
                        "description": "Name of the presentation to list slides for"
                    }
                },
                "required": ["presentation_name"]
            }
        }
    })
    async def list_slides(self, presentation_name: str) -> ToolResult:
        """List all slides in a presentation"""
        try:
            await self._ensure_sandbox()
            
            if not presentation_name:
                return self.fail_response("Presentation name is required.")
            
            safe_name = self._sanitize_filename(presentation_name)
            presentation_path = f"{self.workspace_path}/{self.presentations_dir}/{safe_name}"
            
            # Load metadata
            metadata = await self._load_presentation_metadata(presentation_path)
            
            if not metadata.get("slides"):
                return self.success_response({
                    "message": f"No slides found in presentation '{presentation_name}'",
                    "presentation_name": presentation_name,
                    "slides": [],
                    "total_slides": 0
                })
            
            # Sort slides by number
            slides_info = []
            for slide_num_str, slide_data in metadata["slides"].items():
                slides_info.append({
                    "slide_number": int(slide_num_str),
                    "title": slide_data["title"],
                    "filename": slide_data["filename"],
                    "preview_url": slide_data["preview_url"],
                    "created_at": slide_data.get("created_at", "Unknown")
                })
            
            slides_info.sort(key=lambda x: x["slide_number"])
            
            return self.success_response({
                "message": f"Found {len(slides_info)} slides in presentation '{presentation_name}'",
                "presentation_name": presentation_name,
                "presentation_title": metadata.get("title", "Presentation"),
                "slides": slides_info,
                "total_slides": len(slides_info),
                "presentation_path": f"{self.presentations_dir}/{safe_name}"
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to list slides: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "delete_slide",
            "description": "Delete a specific slide from a presentation",
            "parameters": {
                "type": "object",
                "properties": {
                    "presentation_name": {
                        "type": "string",
                        "description": "Name of the presentation"
                    },
                    "slide_number": {
                        "type": "integer",
                        "description": "Slide number to delete (1-based)"
                    }
                },
                "required": ["presentation_name", "slide_number"]
            }
        }
    })
    async def delete_slide(self, presentation_name: str, slide_number: int) -> ToolResult:
        """Delete a specific slide from a presentation"""
        try:
            await self._ensure_sandbox()
            
            if not presentation_name:
                return self.fail_response("Presentation name is required.")
            
            if slide_number < 1:
                return self.fail_response("Slide number must be 1 or greater.")
            
            safe_name = self._sanitize_filename(presentation_name)
            presentation_path = f"{self.workspace_path}/{self.presentations_dir}/{safe_name}"
            
            # Load metadata
            metadata = await self._load_presentation_metadata(presentation_path)
            
            if not metadata.get("slides") or str(slide_number) not in metadata["slides"]:
                return self.fail_response(f"Slide {slide_number} not found in presentation '{presentation_name}'")
            
            # Get slide info before deletion
            slide_info = metadata["slides"][str(slide_number)]
            slide_filename = slide_info["filename"]
            
            # Delete slide file
            slide_path = f"{presentation_path}/{slide_filename}"
            try:
                await self.sandbox.fs.delete_file(slide_path)
            except:
                pass  # File might not exist
            
            # Remove from metadata
            del metadata["slides"][str(slide_number)]
            
            # Save updated metadata
            await self._save_presentation_metadata(presentation_path, metadata)
            
            return self.success_response({
                "message": f"Slide {slide_number} '{slide_info['title']}' deleted successfully",
                "presentation_name": presentation_name,
                "deleted_slide": slide_number,
                "deleted_title": slide_info['title'],
                "remaining_slides": len(metadata["slides"])
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to delete slide: {str(e)}")




    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_presentations",
            "description": "List all available presentations in the workspace",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    async def list_presentations(self) -> ToolResult:
        """List all presentations in the workspace"""
        try:
            await self._ensure_sandbox()
            presentations_path = f"{self.workspace_path}/{self.presentations_dir}"
            
            try:
                files = await self.sandbox.fs.list_files(presentations_path)
                presentations = []
                
                for file_info in files:
                    if file_info.is_directory:
                        metadata = await self._load_presentation_metadata(f"{presentations_path}/{file_info.name}")
                        presentations.append({
                            "folder": file_info.name,
                            "title": metadata.get("title", "Unknown Title"),
                            "description": metadata.get("description", ""),
                            "total_slides": len(metadata.get("slides", {})),
                            "created_at": metadata.get("created_at", "Unknown"),
                            "updated_at": metadata.get("updated_at", "Unknown")
                        })
                
                return self.success_response({
                    "message": f"Found {len(presentations)} presentations",
                    "presentations": presentations,
                    "presentations_directory": f"/workspace/{self.presentations_dir}"
                })
                
            except Exception as e:
                return self.success_response({
                    "message": "No presentations found",
                    "presentations": [],
                    "presentations_directory": f"/workspace/{self.presentations_dir}",
                    "note": "Create your first slide using create_slide"
                })
                
        except Exception as e:
            return self.fail_response(f"Failed to list presentations: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "delete_presentation",
            "description": "Delete an entire presentation and all its files",
            "parameters": {
                "type": "object",
                "properties": {
                    "presentation_name": {
                        "type": "string",
                        "description": "Name of the presentation to delete"
                    }
                },
                "required": ["presentation_name"]
            }
        }
    })
    async def delete_presentation(self, presentation_name: str) -> ToolResult:
        """Delete a presentation and all its files"""
        try:
            await self._ensure_sandbox()
            
            if not presentation_name:
                return self.fail_response("Presentation name is required.")
            
            safe_name = self._sanitize_filename(presentation_name)
            presentation_path = f"{self.workspace_path}/{self.presentations_dir}/{safe_name}"
            
            try:
                await self.sandbox.fs.delete_folder(presentation_path)
                return self.success_response({
                    "message": f"Presentation '{presentation_name}' deleted successfully",
                    "deleted_path": f"{self.presentations_dir}/{safe_name}"
                })
            except Exception as e:
                return self.fail_response(f"Presentation '{presentation_name}' not found or could not be deleted: {str(e)}")
                
        except Exception as e:
            return self.fail_response(f"Failed to delete presentation: {str(e)}")


    @openapi_schema({
        "type": "function",
        "function": {
            "name": "validate_slide",
            "description": "Validate a slide by reading its HTML code and checking if the content height exceeds 1080px. Use this tool to ensure slides fit within the standard presentation dimensions before finalizing them. This helps maintain proper slide formatting and prevents content overflow issues.",
            "parameters": {
                "type": "object",
                "properties": {
                    "presentation_name": {
                        "type": "string",
                        "description": "Name of the presentation containing the slide to validate"
                    },
                    "slide_number": {
                        "type": "integer",
                        "description": "Slide number to validate (1-based)"
                    }
                },
                "required": ["presentation_name", "slide_number"]
            }
        }
    })
    async def validate_slide(self, presentation_name: str, slide_number: int) -> ToolResult:
        """Validate a slide by rendering it in a browser and measuring actual content height"""
        try:
            await self._ensure_sandbox()
            
            if not presentation_name:
                return self.fail_response("Presentation name is required.")
            
            if slide_number < 1:
                return self.fail_response("Slide number must be 1 or greater.")
            
            safe_name = self._sanitize_filename(presentation_name)
            presentation_path = f"{self.workspace_path}/{self.presentations_dir}/{safe_name}"
            
            # Load metadata to verify slide exists
            metadata = await self._load_presentation_metadata(presentation_path)
            
            if not metadata.get("slides") or str(slide_number) not in metadata["slides"]:
                return self.fail_response(f"Slide {slide_number} not found in presentation '{presentation_name}'")
            
            # Get slide info
            slide_info = metadata["slides"][str(slide_number)]
            slide_filename = slide_info["filename"]
            
            # Create a Python script to measure the actual rendered height using Playwright
            measurement_script = f'''
import asyncio
import json
from playwright.async_api import async_playwright

async def measure_slide_height():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-setuid-sandbox']
        )
        page = await browser.new_page(viewport={{"width": 1920, "height": 1080}})
        
        # Load the HTML file
        await page.goto('file:///workspace/{self.presentations_dir}/{safe_name}/{slide_filename}')
        
        # Wait for page to load
        await page.wait_for_load_state('networkidle')
        
        # Measure the actual content height
        dimensions = await page.evaluate("""
            () => {{
                const body = document.body;
                const html = document.documentElement;
                
                // Get the actual scroll height (total content height)
                const scrollHeight = Math.max(
                    body.scrollHeight, body.offsetHeight,
                    html.clientHeight, html.scrollHeight, html.offsetHeight
                );
                
                // Get viewport height
                const viewportHeight = window.innerHeight;
                
                // Check if content overflows
                const overflows = scrollHeight > 1080;
                
                return {{
                    scrollHeight: scrollHeight,
                    viewportHeight: viewportHeight,
                    overflows: overflows,
                    excessHeight: scrollHeight - 1080
                }};
            }}
        """)
        
        await browser.close()
        return dimensions

result = asyncio.run(measure_slide_height())
print(json.dumps(result))
'''
            
            # Write the script to a temporary file in the sandbox
            script_path = f"{self.workspace_path}/.validate_slide_temp.py"
            await self.sandbox.fs.upload_file(measurement_script.encode(), script_path)
            
            # Execute the script
            try:
                result = await self.sandbox.process.exec(
                    f"/bin/sh -c 'cd /workspace && python3 .validate_slide_temp.py'",
                    timeout=30
                )
                
                # Parse the result
                output = (getattr(result, "result", None) or getattr(result, "output", "") or "").strip()
                if not output:
                    raise Exception("No output from validation script")
                
                dimensions = json.loads(output)
                
                # Clean up the temporary script
                try:
                    await self.sandbox.fs.delete_file(script_path)
                except:
                    pass
                
            except Exception as e:
                # Clean up on error
                try:
                    await self.sandbox.fs.delete_file(script_path)
                except:
                    pass
                return self.fail_response(f"Failed to measure slide dimensions: {str(e)}")
            
            # Analyze results - simple pass/fail
            validation_passed = not dimensions["overflows"]
            
            validation_results = {
                "presentation_name": presentation_name,
                "presentation_path": presentation_path,
                "slide_number": slide_number,
                "slide_title": slide_info["title"],
                "actual_content_height": dimensions["scrollHeight"],
                "target_height": 1080,
                "validation_passed": validation_passed
            }
            
            # Add pass/fail message
            if validation_passed:
                validation_results["message"] = f"✓ Slide {slide_number} '{slide_info['title']}' validation passed. Content height: {dimensions['scrollHeight']}px"
            else:
                validation_results["message"] = f"✗ Slide {slide_number} '{slide_info['title']}' validation failed. Content height: {dimensions['scrollHeight']}px exceeds 1080px limit by {dimensions['excessHeight']}px"
                validation_results["excess_height"] = dimensions["excessHeight"]
            
            return self.success_response(validation_results)
            
        except Exception as e:
            return self.fail_response(f"Failed to validate slide: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "present_presentation",
            "description": "Present the final presentation to the user. Use this tool when: 1) All slides have been created and formatted, 2) The presentation is ready for user review, 3) You want to show the user the complete presentation with all files, 4) The presentation creation process is finished and you want to deliver the final result. IMPORTANT: This tool is specifically for presenting completed presentations, not for intermediate steps. Include the presentation name, slide count, and all relevant file attachments. This tool provides a special UI for presentation delivery. This tool allows users to download the presentation as PDF, PPTX, or upload to Google Slides. **IMPORTANT: Whenever a user wants to download the presentation as PDF, PPTX, or upload to Google Slides, use this tool to present the presentation to the user.**",
            "parameters": {
                "type": "object",
                "properties": {
                    "presentation_name": {
                        "type": "string",
                        "description": "The identifier/folder name of the presentation (e.g., 'test_presentation'). This should match the presentation_name used in create_slide."
                    },
                    "presentation_title": {
                        "type": "string",
                        "description": "The human-readable title of the presentation (e.g., 'Test Presentation'). This will be displayed prominently to the user."
                    },
                    "presentation_path": {
                        "type": "string",
                        "description": "The file path where the presentation is located (e.g., 'presentations/my-presentation/'). This helps users locate the files."
                    },
                    "slide_count": {
                        "type": "integer",
                        "description": "The total number of slides in the presentation. This gives users a quick overview of the presentation size."
                    },
                    "text": {
                        "type": "string",
                        "description": "A summary or description of the presentation to present to the user. Include: 1) What the presentation covers, 2) Key highlights or features, 3) Any important notes about the presentation, 4) How to use or view the presentation."
                    },
                    "attachments": {
                        "anyOf": [
                            {"type": "string"},
                            {"items": {"type": "string"}, "type": "array"}
                        ],
                        "description": "List of HTML slide files to attach (e.g., 'presentations/my-presentation/slide_01.html'). The UI will provide buttons for users to download as PDF, PPTX, or upload to Google Slides, so you only need to provide the HTML files. Always use relative paths to /workspace directory."
                    },
                    "presentation_url": {
                        "type": "string",
                        "description": "(Optional) A direct URL to view the presentation if available. This could be a hosted version or a specific viewing link."
                    }
                },
                "required": ["presentation_name", "presentation_title", "presentation_path", "slide_count", "text", "attachments"]
            }
        }
    })
    async def present_presentation(
        self, 
        presentation_name: str,
        presentation_title: str,
        presentation_path: str,
        slide_count: int,
        text: str,
        attachments: Union[str, List[str]],
        presentation_url: Optional[str] = None
    ) -> ToolResult:
        """Present the final presentation to the user.

        Args:
            presentation_name: The identifier/folder name of the presentation
            presentation_title: The human-readable title of the presentation
            presentation_path: The file path where the presentation is located
            slide_count: The total number of slides in the presentation
            text: A summary or description of the presentation
            attachments: List of presentation files to attach
            presentation_url: Optional direct URL to view the presentation

        Returns:
            ToolResult indicating successful presentation delivery
        """
        try:
            # Convert single attachment to list for consistent handling
            if attachments and isinstance(attachments, str):
                attachments = [attachments]

            # Create a structured response with all presentation data
            result_data = {
                "presentation_name": presentation_name,
                "presentation_title": presentation_title,
                "presentation_path": presentation_path,
                "slide_count": slide_count,
                "text": text,
                "attachments": attachments,
                "presentation_url": presentation_url,
                "status": "presentation_delivered"
            }
                
            return self.success_response(result_data)
        except Exception as e:
            return self.fail_response(f"Error presenting presentation: {str(e)}")