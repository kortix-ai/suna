"""
XML Tool Call Parser Module

This module provides a reliable XML tool call parsing system that supports
the XML format with structured function_calls blocks.
"""

import re
import uuid
from typing import List, Dict, Any, Optional
from dataclasses import dataclass
import json
import logging

logger = logging.getLogger(__name__)


@dataclass
class XMLToolCall:
    """Represents a parsed XML tool call."""
    function_name: str
    parameters: Dict[str, Any]
    raw_xml: str


# Regex patterns for extracting XML blocks
_FUNCTION_CALLS_PATTERN = re.compile(
    r'<function_calls>(.*?)</function_calls>',
    re.DOTALL | re.IGNORECASE
)

_INVOKE_PATTERN = re.compile(
    r'<invoke\s+name=["\']([^"\']+)["\']>(.*?)</invoke>',
    re.DOTALL | re.IGNORECASE
)

_PARAMETER_PATTERN = re.compile(
    r'<parameter\s+name=["\']([^"\']+)["\']>(.*?)</parameter>',
    re.DOTALL | re.IGNORECASE
)


def _parse_parameter_value(value: str) -> Any:
    """Parse a parameter value, attempting to convert to appropriate type."""
    value = value.strip()
    
    # Try to parse as JSON first
    if value.startswith(('{', '[')):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            pass
    
    # Try to parse as boolean
    if value.lower() in ('true', 'false'):
        return value.lower() == 'true'
    
    # Try to parse as number
    try:
        if '.' in value:
            return float(value)
        else:
            return int(value)
    except ValueError:
        pass
    
    # Return as string
    return value


def _parse_invoke_block(function_name: str, invoke_content: str, full_block: str) -> Optional[XMLToolCall]:
    """Parse a single invoke block into an XMLToolCall."""
    parameters = {}
    
    # Extract all parameters
    param_matches = _PARAMETER_PATTERN.findall(invoke_content)
    
    for param_name, param_value in param_matches:
        param_value = param_value.strip()
        parameters[param_name] = _parse_parameter_value(param_value)
    
    # Extract the raw XML for this specific invoke
    invoke_pattern = re.compile(
        rf'<invoke\s+name=["\']{re.escape(function_name)}["\']>.*?</invoke>',
        re.DOTALL | re.IGNORECASE
    )
    raw_xml_match = invoke_pattern.search(full_block)
    raw_xml = raw_xml_match.group(0) if raw_xml_match else f"<invoke name=\"{function_name}\">...</invoke>"
    
    return XMLToolCall(
        function_name=function_name,
        parameters=parameters,
        raw_xml=raw_xml
    )


def parse_xml_tool_calls_to_objects(content: str) -> List[XMLToolCall]:
    """
    Parse XML tool calls from content, returning XMLToolCall objects.
    
    Format: <function_calls><invoke name="function_name"><parameter name="param">value</parameter></invoke></function_calls>
    
    Args:
        content: The text content potentially containing XML tool calls
        
    Returns:
        List of parsed XMLToolCall objects
    """
    tool_calls = []
    
    # Find function_calls blocks
    function_calls_matches = _FUNCTION_CALLS_PATTERN.findall(content)
    
    for fc_content in function_calls_matches:
        # Find all invoke blocks within this function_calls block
        invoke_matches = _INVOKE_PATTERN.findall(fc_content)
        
        for function_name, invoke_content in invoke_matches:
            try:
                tool_call = _parse_invoke_block(function_name, invoke_content, fc_content)
                if tool_call:
                    tool_calls.append(tool_call)
            except Exception as e:
                logger.error(f"Error parsing invoke block for {function_name}: {e}")
    
    return tool_calls


def strip_xml_tool_calls(content: str) -> str:
    """
    Remove XML function call tags from content, leaving only natural text.
    
    Args:
        content: Text content that may contain XML tool calls
        
    Returns:
        Clean text with XML tool call tags removed
    """
    if not content:
        return ""
    
    # Remove function_calls, invoke, and parameter tags
    cleaned = re.sub(r'<function_calls[^>]*>[\s\S]*?</function_calls>', '', content, flags=re.IGNORECASE)
    
    return cleaned.strip()


def extract_xml_chunks(content: str) -> List[str]:
    """
    Extract complete <function_calls> XML chunks from content.
    
    Args:
        content: Text content that may contain XML tool calls
        
    Returns:
        List of complete XML chunks (including <function_calls> tags)
    """
    chunks = []
    pos = 0
    
    try:
        start_pattern = '<function_calls>'
        end_pattern = '</function_calls>'
        
        while pos < len(content):
            # Find the next function_calls block
            start_pos = content.find(start_pattern, pos)
            if start_pos == -1:
                break
            
            # Find the matching end tag
            end_pos = content.find(end_pattern, start_pos)
            if end_pos == -1:
                break
            
            # Extract the complete block including tags
            chunk_end = end_pos + len(end_pattern)
            chunk = content[start_pos:chunk_end]
            chunks.append(chunk)
            
            # Move position past this chunk
            pos = chunk_end
        
    except Exception as e:
        logger.error(f"Error extracting XML chunks: {e}")
        logger.error(f"Content was: {content[:200]}...")
    
    return chunks


def parse_xml_tool_calls_with_ids(
    xml_chunk: str, 
    assistant_message_id: Optional[str] = None, 
    start_index: int = 0
) -> List[Dict[str, Any]]:
    """
    Parse XML chunk into tool call format with generated IDs.
    
    Args:
        xml_chunk: XML content containing <function_calls><invoke> tags
        assistant_message_id: ID of the assistant message (for tool_call_id generation)
        start_index: Starting index for XML tool calls (for tool_call_id generation)
        
    Returns:
        List of tool_call dictionaries, each with 'function_name', 'arguments', 'id', 'source'
    """
    results = []
    try:
        # Check if this is the new format (contains <function_calls>)
        if '<function_calls>' in xml_chunk and '<invoke' in xml_chunk:
            # Parse XML tool calls - returns ALL invoke tags within the chunk
            parsed_calls = parse_xml_tool_calls_to_objects(xml_chunk)
            
            if not parsed_calls:
                logger.error(f"No tool calls found in XML chunk: {xml_chunk[:200]}...")
                return results
            
            # Process ALL tool calls found in the chunk
            for idx, xml_tool_call in enumerate(parsed_calls):
                # Generate tool_call_id in format: xml_tool_index{id}_AssistantMessageId
                tool_index = start_index + idx
                if assistant_message_id:
                    tool_call_id = f"xml_tool_index{tool_index}_{assistant_message_id}"
                else:
                    # Fallback if no assistant_message_id yet
                    tool_call_id = f"xml_tool_index{tool_index}_{str(uuid.uuid4())}"
                
                tool_call = {
                    "function_name": xml_tool_call.function_name,
                    "id": tool_call_id,
                    "arguments": xml_tool_call.parameters,
                    "source": "xml"  # Mark as XML tool call for detection
                }
                
                logger.debug(f"Parsed tool call from chunk: {tool_call['function_name']} (id: {tool_call_id})")
                results.append(tool_call)
            
            logger.debug(f"Parsed {len(results)} tool call(s) from XML chunk")
            return results
        
        # If not the expected <function_calls><invoke> format, return empty list
        logger.error(f"XML chunk does not contain expected <function_calls><invoke> format: {xml_chunk[:200]}...")
        return results
        
    except Exception as e:
        logger.error(f"Error parsing XML chunk: {e}")
        logger.error(f"XML chunk was: {xml_chunk[:200]}...")
        return results


def parse_xml_tool_calls(content: str) -> List[Dict[str, Any]]:
    """
    Parse XML-style function calls from message content.
    
    Convenience function that returns dict format for compatibility with existing code.
    
    Format: <function_calls><invoke name="tool_name"><parameter name="param">value</parameter></invoke></function_calls>
    
    Args:
        content: The text content potentially containing XML tool calls
        
    Returns:
        List of dicts with 'tool_name', 'parameters', and 'raw_xml' keys
    """
    xml_tool_calls = parse_xml_tool_calls_to_objects(content)
    
    # Convert XMLToolCall objects to dict format for compatibility
    return [
        {
            'tool_name': tc.function_name.replace('_', '-'),  # Keep hyphenated format
            'parameters': tc.parameters,
            'raw_xml': tc.raw_xml
        }
        for tc in xml_tool_calls
    ] 