from core.agentpress.tool import ToolResult, openapi_schema, usage_example
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from typing import List, Dict, Optional
import json
import os
from datetime import datetime
import re
from .presentation_styles_config import get_style_config, get_all_styles

class SandboxPresentationTool(SandboxToolsBase):
    """
    Per-slide HTML presentation tool for creating professional presentations.
    Each slide is managed individually with 1920x1080 dimensions.
    Supports iterative slide creation, editing, and presentation assembly.
    """
    
    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.workspace_path = "/workspace"
        self.presentations_dir = "presentations"

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

    def _get_style_config(self, style_name: str) -> Dict:
        """Get style configuration for a given style name"""
        return get_style_config(style_name)

    def _create_slide_html(self, slide_content: str, slide_number: int, total_slides: int, presentation_title: str, style: str = "default") -> str:
        """Create a complete HTML document for a single slide with proper 1920x1080 dimensions"""
        
        # Get style configuration
        style_config = self._get_style_config(style)
        
        html_template = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{presentation_title} - Slide {slide_number}</title>
    <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
    <link href="{style_config['font_import']}" rel="stylesheet">
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/chart.js@3.9.1"></script>
    <style>
        /* Base styling and 1920x1080 slide container */
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}
        
        body {{
            margin: 0;
            padding: 0;
            font-family: {style_config['font_family']};
            color: {style_config['text_color']};
        }}
        
        .slide-container {{
            /* CRITICAL: Standard presentation dimensions */
            width: 1920px;
            height: 1080px;
            max-width: 100vw;
            max-height: 100vh;
            position: relative;
            background: {style_config['background']};
            color: {style_config['text_color']};
            overflow: hidden;
            
            /* Auto-scale to fit viewport while maintaining aspect ratio */
            transform-origin: center center;
            transform: scale(min(100vw / 1920px, 100vh / 1080px));
        }}
        
        /* Slide number indicator */
        .slide-number {{
            position: absolute;
            bottom: 30px;
            right: 30px;
            font-size: 18px;
            color: {style_config['text_color']};
            opacity: 0.7;
            font-weight: 500;
            z-index: 1000;
        }}
        
        /* Common presentation elements with style theming */
        .slide-title {{
            font-size: 48px;
            font-weight: bold;
            margin-bottom: 30px;
            color: {style_config['primary_color']};
        }}
        
        .slide-subtitle {{
            font-size: 32px;
            margin-bottom: 40px;
            color: {style_config['text_color']};
        }}
        
        .slide-content {{
            font-size: 24px;
            line-height: 1.6;
            color: {style_config['text_color']};
        }}
        
        .accent-bar {{
            width: 100px;
            height: 4px;
            background-color: {style_config['accent_color']};
            margin: 20px 0;
        }}
        
        /* Primary color elements */
        .primary-color {{
            color: {style_config['primary_color']};
        }}
        
        .primary-bg {{
            background-color: {style_config['primary_color']};
        }}
        
        /* Accent color elements */
        .accent-color {{
            color: {style_config['accent_color']};
        }}
        
        .accent-bg {{
            background-color: {style_config['accent_color']};
        }}
        
        /* Style-aware text color */
        .text-color {{
            color: {style_config['text_color']};
        }}
        
        /* Responsive images */
        img {{
            max-width: 100%;
            height: auto;
            border-radius: 8px;
        }}
        
        /* List styling */
        ul, ol {{
            margin: 20px 0;
            padding-left: 30px;
        }}
        
        li {{
            margin: 10px 0;
            font-size: 20px;
            line-height: 1.5;
            color: {style_config['text_color']};
        }}
        
        /* Style-specific enhancements */
        .card {{
            background: {'rgba(255, 255, 255, 0.1)' if 'gradient' in style_config['background'] or style_config['background'].startswith('#1') or style_config['background'].startswith('#0') else 'rgba(0, 0, 0, 0.05)'};
            border-radius: 12px;
            padding: 30px;
            backdrop-filter: blur(10px);
        }}
        
        .highlight {{
            background: {style_config['accent_color']};
            color: {'#FFFFFF' if style_config['accent_color'].startswith('#') else style_config['text_color']};
            padding: 4px 12px;
            border-radius: 6px;
            font-weight: 600;
        }}
    </style>
</head>
<body>
    <div class="slide-container">
        {slide_content}
        <div class="slide-number">{slide_number}{f" / {total_slides}" if total_slides > 0 else ""}</div>
    </div>
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

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_slide",
            "description": "Create or update a single slide in a presentation. Each slide is saved as a standalone HTML file with 1920x1080 dimensions (16:9 aspect ratio). Perfect for iterative slide creation and editing. Use 'presentation_styles' tool first to see available styles.",
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
                        "description": "HTML content for the slide body. Should include all styling within the content. The content will be placed inside a 1920x1080 slide container with CSS frameworks (Tailwind, FontAwesome, D3, Chart.js) available. Use professional styling with good typography, spacing, and visual hierarchy. You can use style-aware CSS classes: .primary-color, .primary-bg, .accent-color, .accent-bg, .text-color, .card, .highlight"
                                },
                    "presentation_title": {
                                    "type": "string",
                        "description": "Main title of the presentation (used in HTML title and navigation)",
                        "default": "Presentation"
                    },
                    "style": {
                        "type": "string",
                        "description": "Visual style theme for the slide. Use 'presentation_styles' tool to see all available options. Examples: 'velvet', 'glacier', 'ember', 'sage', 'obsidian', 'coral', 'platinum', 'aurora', 'midnight', 'citrus', or 'default'",
                        "default": "default"
                    }
                },
                "required": ["presentation_name", "slide_number", "slide_title", "content"]
            }
        }
    })
    @usage_example('''
Create individual slides for a presentation about "Modern Web Development":

<function_calls>
<invoke name="create_slide">
<parameter name="presentation_name">modern_web_development</parameter>
<parameter name="slide_number">1</parameter>
<parameter name="slide_title">Title Slide</parameter>
<parameter name="presentation_title">Modern Web Development Trends 2024</parameter>
<parameter name="content"><div style='background: linear-gradient(135deg, #005A9C 0%, #FF6B00 100%); height: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; color: white; padding: 80px;'><h1 style='font-size: 72px; font-weight: bold; margin-bottom: 30px;'>Modern Web Development</h1><div style='width: 150px; height: 6px; background: white; margin: 30px auto;'></div><h2 style='font-size: 36px; margin-bottom: 40px; opacity: 0.9;'>Trends & Technologies 2024</h2><p style='font-size: 24px; opacity: 0.8;'>Building Tomorrow's Web Today</p></div></parameter>
</invoke>
</function_calls>

Then create the next slide:

        <function_calls>
<invoke name="create_slide">
<parameter name="presentation_name">modern_web_development</parameter>
<parameter name="slide_number">2</parameter>
<parameter name="slide_title">Frontend Frameworks</parameter>
<parameter name="presentation_title">Modern Web Development Trends 2024</parameter>
<parameter name="content"><div style='display: flex; height: 100%; padding: 0;'><div style='width: 60%; padding: 80px; display: flex; flex-direction: column; justify-content: center;'><h1 style='font-size: 48px; font-weight: bold; color: #005A9C; margin-bottom: 20px;'>Frontend Frameworks</h1><div style='width: 100px; height: 4px; background: #FF6B00; margin-bottom: 40px;'></div><div style='font-size: 22px; line-height: 1.8;'><div style='margin-bottom: 25px; display: flex; align-items: center;'><i class='fab fa-react' style='color: #61DAFB; font-size: 28px; margin-right: 15px;'></i><div><strong>React</strong> - Component-based UI library</div></div><div style='margin-bottom: 25px; display: flex; align-items: center;'><i class='fab fa-vuejs' style='color: #4FC08D; font-size: 28px; margin-right: 15px;'></i><div><strong>Vue.js</strong> - Progressive framework</div></div></div></div><div style='width: 40%; background: #f8f9fa; display: flex; align-items: center; justify-content: center; padding: 40px;'><div style='text-align: center;'><div style='font-size: 64px; margin-bottom: 30px;'>📱</div><h3 style='font-size: 28px; color: #005A9C;'>Modern Tools</h3></div></div></div></parameter>
        </invoke>
        </function_calls>

This approach allows you to:
- Create slides one at a time
- Edit existing slides by using the same slide number
- Build presentations iteratively
- Mix and match different slide designs
- Each slide is a standalone HTML file with full styling
    ''')
    async def create_slide(
        self,
        presentation_name: str,
        slide_number: int,
        slide_title: str,
        content: str,
        presentation_title: str = "Presentation",
        style: str = "default"
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
                presentation_title=presentation_title,
                style=style
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
                "style": style,
                "created_at": datetime.now().isoformat()
            }
            
            # Save updated metadata
            await self._save_presentation_metadata(presentation_path, metadata)
            
            return self.success_response({
                "message": f"Slide {slide_number} '{slide_title}' created/updated successfully with '{style}' style",
                "presentation_name": presentation_name,
                "presentation_path": f"{self.presentations_dir}/{safe_name}",
                "slide_number": slide_number,
                "slide_title": slide_title,
                "slide_file": f"{self.presentations_dir}/{safe_name}/{slide_filename}",
                "preview_url": f"/workspace/{self.presentations_dir}/{safe_name}/{slide_filename}",
                "style": style,
                "total_slides": len(metadata["slides"]),
                "note": "Slide saved as standalone HTML file with 1920x1080 dimensions"
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
            "name": "presentation_styles",
            "description": "Get available presentation styles with their descriptions and visual characteristics. Use this to show users different style options before creating slides.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    async def presentation_styles(self) -> ToolResult:
        """Get available presentation styles with descriptions and examples"""
        try:
            styles = get_all_styles()
            
            return self.success_response({
                "message": f"Found {len(styles)} presentation styles available",
                "styles": styles,
                "usage_tip": "Choose a style and use it with the 'style' parameter in create_slide"
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to get presentation styles: {str(e)}")

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
