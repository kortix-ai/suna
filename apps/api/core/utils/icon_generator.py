"""
Icon and color generation utilities for agents and projects.
"""
import json
import traceback
from typing import Dict
from core.utils.logger import logger
from core.services.llm import make_llm_api_call

# Lucide React icons (hardcoded for performance)
RELEVANT_ICONS = [
    "accessibility", "activity", "air-vent", "airplay", "alarm-clock", "album",
    "align-left", "align-right", "ambulance", "ampersand", "anchor", "angry",
    "antenna", "anvil", "aperture", "app-window", "apple", "archive", "armchair",
    "arrow-down", "arrow-left", "arrow-right", "arrow-up", "asterisk", "at-sign",
    "atom", "audio-lines", "award", "axe", "axis3d", "baby", "backpack", "badge",
    "baggage-claim", "ban", "banana", "bandage", "banknote", "barcode", "baseline",
    "bath", "battery", "battery-charging", "beaker", "bean", "bed", "beef", "beer",
    "bell", "biceps-flexed", "bike", "binary", "binoculars", "biohazard", "bird",
    "bitcoin", "blend", "blinds", "blocks", "bluetooth", "bold", "bolt", "bomb",
    "bone", "book", "bookmark", "boom-box", "bot", "box", "boxes", "braces",
    "brackets", "brain", "brick-wall", "briefcase", "bring-to-front", "brush",
    "bug", "building", "bus", "cable", "cable-car", "cake", "calculator", "calendar",
    "camera", "candy", "cannabis", "captions", "car", "caravan", "carrot",
    "case-sensitive", "cassette-tape", "cast", "castle", "cat", "cctv", "chart-bar",
    "chart-pie", "check", "chef-hat", "cherry", "chevron-down", "chevron-right",
    "chrome", "church", "cigarette", "circle", "circuit-board", "citrus",
    "clapperboard", "clipboard", "clock", "cloud", "cloud-download", "clover",
    "club", "code", "codepen", "codesandbox", "coffee", "cog", "coins", "columns2",
    "combine", "command", "compass", "component", "computer", "concierge-bell",
    "cone", "construction", "contact", "container", "contrast", "cookie",
    "cooking-pot", "copy", "copyleft", "copyright", "corner-down-left",
    "corner-up-right", "cpu", "creative-commons", "credit-card", "croissant",
    "crop", "cross", "crosshair", "crown", "cuboid", "cup-soda", "currency",
    "cylinder", "dam", "database", "delete", "dessert", "diameter", "diamond",
    "dices", "diff", "disc", "divide", "dna", "dock", "dog", "dollar-sign",
    "donut", "door-open", "dot", "download", "drafting-compass", "drama",
    "dribbble", "drill", "droplet", "drum", "drumstick", "dumbbell", "ear",
    "earth", "eclipse", "egg", "ellipsis", "equal", "eraser", "ethernet-port",
    "euro", "expand", "external-link", "eye", "facebook", "factory", "fan",
    "fast-forward", "feather", "fence", "ferris-wheel", "figma", "file", "files",
    "film", "filter", "filter-x", "fingerprint", "fire-extinguisher", "fish",
    "flag", "flame", "flashlight", "flask-conical", "flip-horizontal",
    "flip-vertical", "flower", "focus", "fold-horizontal", "fold-vertical",
    "folder", "folders", "footprints", "forklift", "forward", "frame", "framer",
    "frown", "fuel", "fullscreen", "gallery-horizontal", "gamepad", "gauge",
    "gavel", "gem", "ghost", "gift", "git-branch", "git-commit-horizontal",
    "git-compare", "git-fork", "git-graph", "git-merge", "git-pull-request",
    "github", "gitlab", "glass-water", "glasses", "globe", "goal", "grab",
    "graduation-cap", "grape", "grid2x2", "grip", "group", "guitar", "ham",
    "hammer", "hand", "hand-helping", "handshake", "hard-drive", "hard-hat",
    "hash", "haze", "hdmi-port", "heading", "headphones", "heart", "heart-off",
    "heater", "hexagon", "highlighter", "history", "hop", "hospital", "hotel",
    "hourglass", "house", "house-plug", "house-plus", "house-wifi",
    "ice-cream-bowl", "ice-cream-cone", "id-card", "image", "image-down",
    "image-minus", "image-off", "image-play", "image-plus", "image-up",
    "image-upscale", "images", "import", "inbox", "indent-decrease",
    "indent-increase", "indian-rupee", "infinity", "info", "inspection-panel",
    "instagram", "italic", "iteration-ccw", "iteration-cw", "japanese-yen",
    "joystick", "kanban", "key", "keyboard", "lamp", "land-plot", "landmark",
    "languages", "laptop", "lasso", "laugh", "layers", "layout-grid", "leaf",
    "lectern", "letter-text", "library", "life-buoy", "ligature", "lightbulb",
    "link", "linkedin", "list", "list-check", "list-plus", "loader", "locate",
    "lock", "lock-open", "log-in", "log-out", "logs", "lollipop", "luggage",
    "magnet", "mail", "mailbox", "mails", "map", "map-pin", "mars", "mars-stroke",
    "martini", "maximize", "medal", "megaphone", "meh", "memory-stick", "menu",
    "merge", "message-circle", "mic", "microchip", "microscope", "microwave",
    "milestone", "milk", "minimize", "minus", "monitor", "moon", "mountain",
    "mouse", "move-left", "move-right", "move-up", "move-down", "music",
    "navigation", "network", "newspaper", "nfc", "non-binary", "notebook",
    "notepad-text", "nut", "octagon", "omega", "option", "orbit", "origami",
    "package", "package-plus", "paintbrush", "palette", "panel-bottom",
    "panel-left", "panel-right", "panel-top", "panels-left-bottom",
    "panels-right-bottom", "panels-top-left", "paperclip", "parentheses",
    "parking-meter", "party-popper", "pause", "paw-print", "pc-case", "pen",
    "pencil", "pentagon", "percent", "person-standing", "philippine-peso",
    "phone", "pi", "piano", "pickaxe", "picture-in-picture", "piggy-bank",
    "pilcrow", "pill", "pill-bottle", "pin", "pipette", "pizza", "plane", "play",
    "plug", "plus", "pocket", "pocket-knife", "podcast", "pointer", "popcorn",
    "popsicle", "pound-sterling", "power", "presentation", "printer", "projector",
    "proportions", "puzzle", "pyramid", "qr-code", "quote", "rabbit", "radar",
    "radiation", "radical", "radio", "radius", "rail-symbol", "rainbow", "rat",
    "ratio", "receipt", "rectangle-horizontal", "recycle", "redo", "refresh-ccw",
    "refresh-cw", "refrigerator", "regex", "remove-formatting", "repeat",
    "replace", "reply", "rewind", "ribbon", "rocket", "rocking-chair",
    "roller-coaster", "rotate-ccw", "rotate-cw", "rotate3d", "route", "router",
    "rows2", "rss", "ruler", "russian-ruble", "sailboat", "salad", "sandwich",
    "satellite", "satellite-dish", "save", "scale", "scale3d", "scaling", "scan",
    "school", "scissors", "screen-share", "scroll", "search", "section", "send",
    "send-to-back", "separator-horizontal", "separator-vertical", "server",
    "settings", "shapes", "share", "sheet", "shell", "shield", "ship",
    "ship-wheel", "shirt", "shopping-cart", "shovel", "shower-head", "shrink",
    "shrub", "shuffle", "sigma", "signal", "signature", "signpost", "siren",
    "skip-back", "skip-forward", "skull", "slack", "slash", "slice",
    "sliders-horizontal", "smartphone", "smile", "snail", "snowflake", "sofa",
    "soup", "space", "spade", "sparkles", "speaker", "speech", "spell-check",
    "spline", "split", "spray-can", "sprout", "square", "squircle", "squirrel",
    "stamp", "star", "step-forward", "stethoscope", "sticker", "sticky-note",
    "store", "stretch-horizontal", "strikethrough", "subscript", "sun",
    "superscript", "swatch-book", "swiss-franc", "switch-camera", "sword",
    "swords", "syringe", "table", "tablet", "tag", "tally1", "tangent", "target",
    "telescope", "tent", "terminal", "test-tube", "text", "theater",
    "thermometer", "thumbs-down", "thumbs-up", "ticket", "timer", "toggle-right",
    "toilet", "tornado", "torus", "touchpad", "tower-control", "toy-brick",
    "tractor", "traffic-cone", "train-front", "transgender", "trash", "tree-pine",
    "trello", "trending-down", "trending-up", "trending-up-down", "triangle",
    "trophy", "truck", "turtle", "tv", "twitch", "twitter", "type", "umbrella",
    "underline", "undo", "unfold-horizontal", "unfold-vertical", "ungroup",
    "university", "unlink", "unplug", "upload", "usb", "user", "users",
    "utensils", "utility-pole", "variable", "vault", "vegan", "venetian-mask",
    "venus", "venus-and-mars", "vibrate", "video", "videotape", "view",
    "voicemail", "volleyball", "volume", "vote", "wallet", "wallpaper", "wand",
    "warehouse", "washing-machine", "watch", "waves", "waypoints", "webcam",
    "webhook", "weight", "wheat", "whole-word", "wifi", "wind", "wind-arrow-down",
    "wine", "workflow", "worm", "wrap-text", "wrench", "x", "youtube", "zap",
    "zap-off", "zoom-in", "zoom-out"
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
        model_name = "openai/gpt-5-nano-2025-08-07"
        
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

