"""
Icon and color generation utilities for agents and projects.
"""
import json
import traceback
from typing import Dict
from pathlib import Path
from core.utils.logger import logger
from core.services.llm import make_llm_api_call

# Load Lucide React icons once at module level for performance
try:
    icons_file_path = Path(__file__).parent.parent.parent / 'lucide_icons_cleaned.json'
    with open(icons_file_path, 'r') as f:
        RELEVANT_ICONS = json.load(f)
    logger.info(f"Loaded {len(RELEVANT_ICONS)} Lucide React icons from file")
except Exception as e:
    logger.warning(f"Failed to load icons file: {e}. Using fallback icons.")
    # Fallback to essential icons if file loading fails
    RELEVANT_ICONS = [
        # Core AI/Agent icons
        "message-circle", "code", "brain", "sparkles", "zap", "rocket", "bot",
        "cpu", "microchip", "terminal", "workflow", "target", "lightbulb",
        
        # Data & Storage
        "database", "file", "files", "folder", "folders", "hard-drive", "cloud",
        "download", "upload", "save", "copy", "trash", "archive",
        
        # User & Communication
        "user", "users", "mail", "phone", "send", "reply", "bell", 
        "headphones", "mic", "video", "camera",
        
        # Navigation & UI
        "house", "globe", "map", "map-pin", "search", "filter", "settings",
        "menu", "grid2x2", "list", "layout-grid", "panel-left", "panel-right",
        
        # Actions & Tools
        "play", "pause", "refresh-cw", "rotate-cw", "wrench", "pen", "pencil", 
        "brush", "scissors", "hammer",
        
        # Status & Feedback
        "check", "x", "plus", "minus", "info", "thumbs-up", "thumbs-down", 
        "heart", "star", "flag", "bookmark",
        
        # Time & Calendar
        "clock", "calendar", "timer", "hourglass", "history",
        
        # Security & Privacy
        "shield", "lock", "key", "fingerprint", "eye",
        
        # Business & Productivity
        "briefcase", "building", "store", "shopping-cart", "credit-card",
        "chart-bar", "chart-pie", "trending-up", "trending-down",
        
        # Creative & Media
        "music", "image", "images", "film", "palette", "paintbrush",
        "speaker", "volume",
        
        # System & Technical
        "cog", "monitor", "laptop", "smartphone", "wifi", "bluetooth", 
        "usb", "plug", "battery", "power",
        
        # Nature & Environment
        "sun", "moon", "leaf", "flower", "mountain", "earth"
    ]


async def generate_icon_and_colors(name: str, description: str = "") -> Dict[str, str]:
    """
    Generate appropriate icon and color scheme for an agent or project.
    
    Args:
        name: The name of the agent/project
        description: Optional description for better context
        
    Returns:
        Dict with keys: icon_name, icon_color, icon_background
    """
    logger.debug(f"Generating icon and colors for: {name}")
    try:
        model_name = "openai/gpt-4o-mini"
        
        frontend_colors = [
            "#000000", "#FFFFFF", "#6366F1", "#10B981", "#F59E0B", 
            "#EF4444", "#8B5CF6", "#EC4899", "#14B8A6", "#F97316",
            "#06B6D4", "#84CC16", "#F43F5E", "#A855F7", "#3B82F6"
        ]
        
        context = f"Name: {name}"
        if description:
            context += f"\nDescription: {description}"
            
        system_prompt = f"""You are a helpful assistant that selects appropriate icons and colors for AI agents based on their name and description.

Available Lucide React icons to choose from:
{', '.join(RELEVANT_ICONS)}

Available colors (hex codes):
{', '.join(frontend_colors)}

Respond with a JSON object containing:
- "icon": The most appropriate icon name from the available icons
- "background_color": A background color hex code from the available colors
- "text_color": A text color hex code from the available colors (choose one that contrasts well with the background)

Example response:
{{"icon": "youtube", "background_color": "#EF4444", "text_color": "#FFFFFF"}}"""

        user_message = f"Select the most appropriate icon and color scheme for this AI agent:\n{context}"
        messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_message}]

        logger.debug(f"Calling LLM ({model_name}) for icon and color generation.")
        response = await make_llm_api_call(
            messages=messages, 
            model_name=model_name, 
            max_tokens=4000, 
            temperature=0.7,
            response_format={"type": "json_object"},
            stream=False
        )

        # Default fallback values
        result = {
            "icon_name": "bot",
            "icon_color": "#FFFFFF", 
            "icon_background": "#6366F1"
        }
        
        if response and response.get('choices') and response['choices'][0].get('message'):
            raw_content = response['choices'][0]['message'].get('content', '').strip()
            try:
                parsed_response = json.loads(raw_content)
                
                if isinstance(parsed_response, dict):
                    # Extract and validate icon
                    icon = parsed_response.get('icon', '').strip()
                    if icon and icon in RELEVANT_ICONS:
                        result["icon_name"] = icon
                        logger.debug(f"LLM selected icon: '{icon}'")
                    else:
                        logger.warning(f"LLM selected invalid icon '{icon}', using default 'bot'")
                    
                    # Extract and validate colors
                    bg_color = parsed_response.get('background_color', '').strip()
                    text_color = parsed_response.get('text_color', '').strip()
                    
                    if bg_color in frontend_colors:
                        result["icon_background"] = bg_color
                        logger.debug(f"LLM selected background color: '{bg_color}'")
                    else:
                        logger.warning(f"LLM selected invalid background color '{bg_color}', using default")
                    
                    if text_color in frontend_colors:
                        result["icon_color"] = text_color
                        logger.debug(f"LLM selected text color: '{text_color}'")
                    else:
                        logger.warning(f"LLM selected invalid text color '{text_color}', using default")
                        
                else:
                    logger.warning(f"LLM returned non-dict JSON: {parsed_response}")
                    
            except json.JSONDecodeError as e:
                logger.warning(f"Failed to parse LLM JSON response: {e}. Raw content: {raw_content}")
        else:
            logger.warning(f"Failed to get valid response from LLM for icon generation. Response: {response}")

        logger.debug(f"Generated styling: icon={result['icon_name']}, bg={result['icon_background']}, color={result['icon_color']}")
        return result

    except Exception as e:
        logger.error(f"Error in icon generation: {str(e)}\n{traceback.format_exc()}")
        # Return safe defaults on error (using Indigo theme)
        return {
            "icon_name": "bot",
            "icon_color": "#FFFFFF", 
            "icon_background": "#6366F1"
        }

