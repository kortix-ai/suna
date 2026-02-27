"""
JSON helper utilities for handling both legacy (string) and new (dict/list) formats.

These utilities help with the transition from storing JSON as strings to storing
them as proper JSONB objects in the database.
"""

import json
import re
import logging
from typing import Any, Union, Dict, List, Tuple

# Use orjson for hot paths (3-5x faster than stdlib json)
try:
    import orjson
    _HAS_ORJSON = True
except ImportError:
    _HAS_ORJSON = False

logger = logging.getLogger(__name__)


def repair_json(json_string: str) -> Tuple[str, bool]:
    """
    Attempt to repair malformed JSON that LLMs sometimes produce.
    
    Common LLM JSON mistakes this handles:
    - Missing closing brackets/braces (e.g., `[{"a": 1}, {"b": 2]` -> `[{"a": 1}, {"b": 2}]`)
    - Trailing commas (e.g., `[1, 2, 3,]` -> `[1, 2, 3]`)
    - Missing commas between array elements (e.g., `[{"a":1} {"b":2}]` -> `[{"a":1}, {"b":2}]`)
    
    Args:
        json_string: The potentially malformed JSON string
        
    Returns:
        Tuple of (repaired_string, was_repaired)
    """
    if not isinstance(json_string, str):
        return json_string, False
    
    original = json_string
    repaired = json_string.strip()
    was_repaired = False
    
    # First, try parsing as-is
    try:
        json.loads(repaired)
        return repaired, False
    except json.JSONDecodeError:
        pass
    
    # Fix 1: Remove trailing commas before ] or }
    # Pattern: comma followed by optional whitespace, then ] or }
    trailing_comma_pattern = r',(\s*[\]\}])'
    if re.search(trailing_comma_pattern, repaired):
        repaired = re.sub(trailing_comma_pattern, r'\1', repaired)
        was_repaired = True
    
    # Fix 2: Add missing commas between array elements or object properties
    # Pattern: } followed by optional whitespace, then { (missing comma)
    missing_comma_pattern = r'\}(\s*)\{'
    if re.search(missing_comma_pattern, repaired):
        repaired = re.sub(missing_comma_pattern, r'},\1{', repaired)
        was_repaired = True
    
    # Pattern: ] followed by optional whitespace, then [ (missing comma between arrays)
    missing_comma_array_pattern = r'\](\s*)\['
    if re.search(missing_comma_array_pattern, repaired):
        repaired = re.sub(missing_comma_array_pattern, r'],\1[', repaired)
        was_repaired = True
    
    # Fix 3: Balance brackets/braces - count and add missing ones
    # This handles the specific case: `[{...}, {...], {...]` -> `[{...}, {...}]`
    open_braces = repaired.count('{')
    close_braces = repaired.count('}')
    open_brackets = repaired.count('[')
    close_brackets = repaired.count(']')
    
    # Add missing closing braces
    if open_braces > close_braces:
        # Find position to insert - look for patterns like `], {` that should be `}], {`
        # or at the end of the string
        missing_braces = open_braces - close_braces
        
        # Try to find where braces are missing by checking for ], or ] at end
        # Common pattern: `["task1", "task2"], {` should be `["task1", "task2"]}, {`
        # Look for `],` or `]` followed by `,` or `}` or end - missing `}` before
        fixed = False
        for i in range(len(repaired) - 1, 0, -1):
            if repaired[i] == ']':
                # Check if there's a missing } before this ]
                # Count braces up to this point
                temp_open = repaired[:i+1].count('{')
                temp_close = repaired[:i+1].count('}')
                if temp_open > temp_close:
                    # Insert missing }s before the ]
                    needed = temp_open - temp_close
                    repaired = repaired[:i] + '}' * needed + repaired[i:]
                    was_repaired = True
                    fixed = True
                    break
        
        if not fixed:
            # Just append at end
            repaired = repaired + '}' * missing_braces
            was_repaired = True
    
    # Add missing closing brackets
    if open_brackets > close_brackets:
        missing_brackets = open_brackets - close_brackets
        repaired = repaired + ']' * missing_brackets
        was_repaired = True
    
    # Validate the repair worked
    try:
        json.loads(repaired)
        if was_repaired:
            logger.info(f"🔧 [JSON REPAIR] Successfully repaired malformed JSON")
            logger.debug(f"🔧 [JSON REPAIR] Original (first 200 chars): {original[:200]}")
            logger.debug(f"🔧 [JSON REPAIR] Repaired (first 200 chars): {repaired[:200]}")
        return repaired, was_repaired
    except json.JSONDecodeError as e:
        # Repair failed, return original
        logger.debug(f"🔧 [JSON REPAIR] Repair attempt failed: {e}")
        return original, False


def safe_json_parse_with_repair(value: Union[str, Dict, List, Any], default: Any = None) -> Any:
    """
    Safely parse JSON with automatic repair of common LLM mistakes.
    
    This is an enhanced version of safe_json_parse that attempts to repair
    malformed JSON before giving up.
    
    Args:
        value: The value to parse
        default: Default value if parsing fails
        
    Returns:
        Parsed value or default
    """
    if value is None:
        return default
        
    # If it's already a dict or list, return as-is
    if isinstance(value, (dict, list)):
        return value
        
    # If it's a string, try to parse it
    if isinstance(value, str):
        # First, try normal parsing
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            pass
        
        # Try repair
        repaired, was_repaired = repair_json(value)
        if was_repaired:
            try:
                return json.loads(repaired)
            except json.JSONDecodeError:
                pass
        
        # If repair didn't work, return the string itself or default
        return value if default is None else default
            
    # For any other type, return as-is
    return value


def ensure_dict(value: Union[str, Dict[str, Any], None], default: Dict[str, Any] = None) -> Dict[str, Any]:
    """
    Ensure a value is a dictionary.
    
    Handles:
    - None -> returns default or {}
    - Dict -> returns as-is
    - JSON string -> parses and returns dict
    - Other -> returns default or {}
    
    Args:
        value: The value to ensure is a dict
        default: Default value if conversion fails
        
    Returns:
        A dictionary
    """
    if default is None:
        default = {}
        
    if value is None:
        return default
        
    if isinstance(value, dict):
        return value
        
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return parsed
            return default
        except (json.JSONDecodeError, TypeError):
            return default
            
    return default


def ensure_list(value: Union[str, List[Any], None], default: List[Any] = None) -> List[Any]:
    """
    Ensure a value is a list.
    
    Handles:
    - None -> returns default or []
    - List -> returns as-is
    - JSON string -> parses and returns list
    - Other -> returns default or []
    
    Args:
        value: The value to ensure is a list
        default: Default value if conversion fails
        
    Returns:
        A list
    """
    if default is None:
        default = []
        
    if value is None:
        return default
        
    if isinstance(value, list):
        return value
        
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return parsed
            return default
        except (json.JSONDecodeError, TypeError):
            return default
            
    return default


def safe_json_parse(value: Union[str, Dict, List, Any], default: Any = None) -> Any:
    """
    Safely parse a value that might be JSON string or already parsed.
    
    This handles the transition period where some data might be stored as
    JSON strings (old format) and some as proper objects (new format).
    
    Args:
        value: The value to parse
        default: Default value if parsing fails
        
    Returns:
        Parsed value or default
    """
    if value is None:
        return default
        
    # If it's already a dict or list, return as-is
    if isinstance(value, (dict, list)):
        return value
        
    # If it's a string, try to parse it
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            # If it's not valid JSON, return the string itself
            return value
            
    # For any other type, return as-is
    return value


def to_json_string(value: Any) -> str:
    """
    Convert a value to a JSON string if needed.
    
    This is used for backwards compatibility when yielding data that
    expects JSON strings.
    
    Uses ensure_ascii=False to preserve Unicode characters without escaping,
    preventing double-escaping issues when JSON strings are nested.
    
    Args:
        value: The value to convert
        
    Returns:
        JSON string representation
    """
    if isinstance(value, str):
        # If it's already a string, check if it's valid JSON
        try:
            json.loads(value)
            return value  # It's already a JSON string
        except (json.JSONDecodeError, TypeError):
            # It's a plain string, encode it as JSON
            return json.dumps(value, ensure_ascii=False)
    
    # For all other types, convert to JSON
    return json.dumps(value, ensure_ascii=False)


def to_json_string_fast(value: Any) -> str:
    """
    Fast path for converting to JSON string - no validation.
    
    Use this when you KNOW the value is a dict/list that needs serialization.
    This is optimized for the streaming hot path where we serialize every chunk.
    
    Uses orjson when available (3-5x faster than stdlib json) for hot paths.
    Falls back to stdlib json if orjson is not available.
    
    Args:
        value: The value to convert (must be JSON-serializable)
        
    Returns:
        JSON string representation
    """
    if _HAS_ORJSON:
        # orjson is 3-5x faster and handles Unicode correctly by default
        return orjson.dumps(value).decode('utf-8')
    else:
        # Fallback to stdlib json with compact format
        return json.dumps(value, separators=(',', ':'), ensure_ascii=False)


def format_for_yield(message_object: Dict[str, Any]) -> Dict[str, Any]:
    """
    Format a message object for yielding, ensuring content and metadata are JSON strings.
    
    This maintains backward compatibility with clients expecting JSON strings
    while the database now stores proper objects.
    
    Args:
        message_object: The message object from the database
        
    Returns:
        Message object with content and metadata as JSON strings
    """
    if not message_object:
        return message_object
        
    # Create a copy to avoid modifying the original
    formatted = message_object.copy()
    
    # Ensure content is a JSON string
    if 'content' in formatted and not isinstance(formatted['content'], str):
        formatted['content'] = json.dumps(formatted['content'])
        
    # Ensure metadata is a JSON string
    if 'metadata' in formatted and not isinstance(formatted['metadata'], str):
        formatted['metadata'] = json.dumps(formatted['metadata'])
        
    return formatted 