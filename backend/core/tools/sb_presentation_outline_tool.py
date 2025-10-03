from core.agentpress.tool import ToolResult, openapi_schema
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from typing import List, Dict, Optional
import json


class SandboxPresentationOutlineTool(SandboxToolsBase):
    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_presentation_outline",
            "description": "Create a structured outline for a presentation with slide titles and descriptions. This tool helps plan the overall structure and flow of a presentation before creating the actual slides. The final presentation will use FLAT DESIGN principles with clean typography, solid colors, and no gradients/shadows/animations. Standard PowerPoint dimensions (1920x1080, 16:9 aspect ratio) will be maintained.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "The main title of the presentation"
                    },
                    "subtitle": {
                        "type": "string",
                        "description": "Optional subtitle or tagline for the presentation"
                    },
                    "slides": {
                        "type": "array",
                        "description": "Array of slide outlines with title and description",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {
                                    "type": "string",
                                    "description": "The title of the slide"
                                },
                                "description": {
                                    "type": "string",
                                    "description": "Brief description of the slide content and purpose"
                                },
                                "notes": {
                                    "type": "string",
                                    "description": "Optional speaker notes or additional context"
                                }
                            },
                            "required": ["title", "description"]
                        }
                    }
                },
                "required": ["title", "slides"]
            }
        }
    })
    async def create_presentation_outline(
        self,
        title: str,
        slides: List[Dict[str, str]],
        subtitle: Optional[str] = None
    ) -> ToolResult:
        try:
            if not title:
                return self.fail_response("Presentation title is required.")
            
            if not slides or not isinstance(slides, list):
                return self.fail_response("At least one slide outline is required.")
            
            for i, slide in enumerate(slides):
                if not isinstance(slide, dict):
                    return self.fail_response(f"Slide {i+1} must be a dictionary with 'title' and 'description'.")
                
                if not slide.get("title"):
                    return self.fail_response(f"Slide {i+1} is missing a title.")
                
                if not slide.get("description"):
                    return self.fail_response(f"Slide {i+1} is missing a description.")
            
            outline_text = f"# {title}\n"
            if subtitle:
                outline_text += f"## {subtitle}\n"
            outline_text += f"\nTotal slides: {len(slides)}\n\n"
            
            for i, slide in enumerate(slides, 1):
                outline_text += f"### Slide {i}: {slide['title']}\n"
                outline_text += f"**Description:** {slide['description']}\n"
                if slide.get('notes'):
                    outline_text += f"**Notes:** {slide['notes']}\n"
                outline_text += "\n"
            
            return self.success_response({
                "title": title,
                "subtitle": subtitle,
                "slide_count": len(slides),
                "slides": slides,
                "outline_text": outline_text
            })
            
        except Exception as e:
            return self.fail_response(f"Failed to create presentation outline: {str(e)}") 