"""
Message Sanitizer - Converts raw database messages to frontend-ready format.

This module handles parsing of different message formats (XML tool calls, native function calls, etc.)
and converts them to a consistent, sanitized format that's ready for frontend rendering.
"""

import json
import re
from typing import Dict, Any, List, Optional, Union
from core.utils.logger import logger


def safe_json_parse(value: Any, default: Any = None) -> Any:
    """Safely parse JSON string to dict/list/etc."""
    if value is None:
        return default
    if isinstance(value, (dict, list, bool, int, float)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, ValueError):
            return default
    return default


def parse_xml_tool_calls(content: str) -> List[Dict[str, Any]]:
    """
    Parse XML-style function calls from message content.
    
    Format: <function_calls><invoke name="tool_name"><parameter name="param">value</parameter></invoke></function_calls>
    """
    tool_calls = []
    
    # Find all function_calls blocks
    function_calls_regex = r'<function_calls>([\s\S]*?)</function_calls>'
    function_calls_matches = re.finditer(function_calls_regex, content, re.IGNORECASE)
    
    for fc_match in function_calls_matches:
        function_calls_content = fc_match.group(1)
        
        # Find all invoke blocks within this function_calls
        invoke_regex = r'<invoke\s+name=["|\']([^"\']+)["|\']>([\s\S]*?)</invoke>'
        invoke_matches = re.finditer(invoke_regex, function_calls_content, re.IGNORECASE)
        
        for invoke_match in invoke_matches:
            tool_name = invoke_match.group(1).replace('_', '-')
            invoke_content = invoke_match.group(2)
            
            # Extract parameters
            parameters = {}
            param_regex = r'<parameter\s+name=["|\']([^"\']+)["|\']>([\s\S]*?)</parameter>'
            param_matches = re.finditer(param_regex, invoke_content, re.IGNORECASE)
            
            for param_match in param_matches:
                param_name = param_match.group(1)
                param_value = param_match.group(2).strip()
                
                # Try to parse JSON values
                try:
                    parameters[param_name] = json.loads(param_value)
                except (json.JSONDecodeError, ValueError):
                    parameters[param_name] = param_value
            
            tool_calls.append({
                'tool_name': tool_name,
                'parameters': parameters,
                'raw_xml': invoke_match.group(0)
            })
    
    return tool_calls


def strip_xml_tool_calls(content: str) -> str:
    """Remove XML function call tags from content, leaving only natural text."""
    if not content:
        return ""
    
    # Remove function_calls, invoke, and parameter tags
    cleaned = re.sub(r'<function_calls[^>]*>[\s\S]*?</function_calls>', '', content, flags=re.IGNORECASE)
    
    return cleaned.strip()


def sanitize_message(message: Dict[str, Any]) -> Dict[str, Any]:
    """
    Convert a raw database message to sanitized frontend format.
    
    Args:
        message: Raw message from database with JSON-stringified content/metadata
        
    Returns:
        Sanitized message ready for frontend consumption, or None if should be filtered out
    """
    msg_type = message.get('type', '')
    content = safe_json_parse(message.get('content', '{}'), {})
    metadata = safe_json_parse(message.get('metadata', '{}'), {})
    
    # ONLY process user, assistant, and tool types - skip everything else
    if msg_type not in ['user', 'assistant', 'tool']:
        return None
    
    # Base sanitized message structure
    sanitized = {
        'message_id': message.get('message_id'),
        'type': msg_type,
        'created_at': message.get('created_at'),
        'updated_at': message.get('updated_at'),
        'sequence': message.get('sequence'),
    }
    
    # Handle different message types - simplified to 3 main types
    if msg_type == 'user':
        sanitized['type'] = 'user'
        sanitized['content'] = {
            'text': content.get('content', '') if isinstance(content, dict) else str(content),
            'attachments': content.get('attachments', []) if isinstance(content, dict) else []
        }
        
    elif msg_type == 'assistant':
        # Assistant message - could contain text and/or tool calls
        assistant_content = content.get('content', '') if isinstance(content, dict) else str(content)
        
        # Check for XML tool calls
        tool_calls = parse_xml_tool_calls(assistant_content)
        
        # Clean text (remove XML tags)
        clean_text = strip_xml_tool_calls(assistant_content)
        
        sanitized['type'] = 'assistant'
        sanitized['content'] = {
            'text': clean_text,
            'tool_calls': [
                {
                    'name': tc['tool_name'],
                    'parameters': tc['parameters']
                }
                for tc in tool_calls
            ] if tool_calls else []
        }
        sanitized['metadata'] = {
            'agent_id': message.get('agent_id'),
            'agent_name': message.get('agents', {}).get('name') if message.get('agents') else None,
            'stream_status': metadata.get('stream_status')
        }
    
    elif msg_type == 'tool':
        # Tool result message
        tool_content = content.get('content', content) if isinstance(content, dict) else content
        
        # Try to parse tool content structure
        tool_data = safe_json_parse(tool_content, {})
        
        # DEBUG: Log raw content to understand structure
        logger.debug(f"[SANITIZER DEBUG] Raw tool message:")
        logger.debug(f"  content type: {type(content)}")
        logger.debug(f"  content keys: {content.keys() if isinstance(content, dict) else 'N/A'}")
        logger.debug(f"  tool_content: {str(tool_content)[:200]}")
        logger.debug(f"  tool_data type: {type(tool_data)}")
        logger.debug(f"  tool_data keys: {tool_data.keys() if isinstance(tool_data, dict) else 'N/A'}")
        logger.debug(f"  metadata keys: {metadata.keys() if isinstance(metadata, dict) else 'N/A'}")
        logger.debug(f"  assistant_message_id: {metadata.get('assistant_message_id')}")
        logger.debug(f"  tool_index: {metadata.get('tool_index')}")
        
        sanitized['type'] = 'tool'
        
        # Handle different tool result formats
        if isinstance(tool_data, dict):
            # Check if it's wrapped in 'tool_execution'
            if 'tool_execution' in tool_data:
                tool_exec = tool_data['tool_execution']
                tool_name = tool_exec.get('xml_tag_name', tool_exec.get('function_name', 'unknown'))
            else:
                # Fallback for other formats
                tool_name = tool_data.get('tool_name', tool_data.get('xml_tag_name', tool_data.get('name', 'unknown')))
            
            sanitized['content'] = {
                'name': tool_name,
                'result': tool_data.get('result', tool_data),
                'success': tool_data.get('success', True),
                'error': tool_data.get('error')
            }
        else:
            sanitized['content'] = {
                'name': 'unknown',
                'result': tool_content,
                'success': True,
                'error': None
            }
        
        sanitized['metadata'] = {
            'tool_call_id': content.get('tool_call_id') if isinstance(content, dict) else None,
            'linked_message_id': metadata.get('assistant_message_id'),
            'tool_index': metadata.get('tool_index')
        }
    
    return sanitized


def sanitize_streaming_message(message: Dict[str, Any]) -> Dict[str, Any]:
    """
    Sanitize a streaming message chunk.
    
    Streaming messages may be partial/incomplete, so we handle them specially.
    """
    msg_type = message.get('type', '')
    content = safe_json_parse(message.get('content', '{}'), {})
    metadata = safe_json_parse(message.get('metadata', '{}'), {})
    
    # Check if this is a chunk or complete message
    is_chunk = metadata.get('stream_status') == 'chunk'
    
    sanitized = {
        'message_id': message.get('message_id'),
        'type': msg_type,
        'streaming': is_chunk,
        'sequence': message.get('sequence'),
    }
    
    if msg_type == 'assistant':
        assistant_content = content.get('content', '') if isinstance(content, dict) else str(content)
        
        sanitized['type'] = 'assistant'
        
        # For streaming chunks, send raw content (don't parse tool calls yet)
        if is_chunk:
            sanitized['content'] = {
                'text': assistant_content,
                'tool_calls': []
            }
        else:
            # Complete message - parse tool calls
            tool_calls = parse_xml_tool_calls(assistant_content)
            clean_text = strip_xml_tool_calls(assistant_content)
            
            sanitized['content'] = {
                'text': clean_text,
                'tool_calls': [
                    {
                        'name': tc['tool_name'],
                        'parameters': tc['parameters']
                    }
                    for tc in tool_calls
                ] if tool_calls else []
            }
    
    elif msg_type == 'tool':
        tool_content = content.get('content', content) if isinstance(content, dict) else content
        tool_data = safe_json_parse(tool_content, {})
        
        sanitized['type'] = 'tool'
        if isinstance(tool_data, dict):
            sanitized['content'] = {
                'name': tool_data.get('tool_name', tool_data.get('xml_tag_name', 'unknown')),
                'result': tool_data.get('result', tool_data),
                'success': tool_data.get('success', True)
            }
        else:
            sanitized['content'] = {
                'name': 'unknown',
                'result': tool_content,
                'success': True
            }
    
    else:
        # Other types (status, user, etc.)
        sanitized['content'] = content
    
    return sanitized


def sanitize_messages_batch(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Sanitize a batch of messages and embed tool results into assistant messages.
    
    The output structure will be clean:
    - USER messages
    - ASSISTANT messages (with tool_calls that include their results)
    - Tool messages are NOT returned separately - they're embedded in assistant messages
    
    Args:
        messages: List of raw database messages
        
    Returns:
        List of sanitized messages (only user and assistant types)
    """
    sanitized = []
    assistant_map = {}  # Map assistant message_id to its sanitized message
    tool_results = {}   # Map linked_message_id to list of tool results
    
    # First pass: sanitize all messages and collect tool results
    temp_sanitized = []
    for message in messages:
        sanitized_msg = sanitize_message(message)
        if sanitized_msg is not None:
            temp_sanitized.append(sanitized_msg)
            
            # Track assistant messages
            if sanitized_msg['type'] == 'assistant':
                assistant_map[sanitized_msg['message_id']] = sanitized_msg
                logger.debug(f"[SANITIZER] Tracked assistant message: {sanitized_msg['message_id']}")
            
            # Collect tool results by their linked assistant message
            elif sanitized_msg['type'] == 'tool':
                linked_id = sanitized_msg.get('metadata', {}).get('linked_message_id')
                logger.debug(f"[SANITIZER] Tool result: linked_id={linked_id}, tool_name={sanitized_msg.get('content', {}).get('name')}")
                if linked_id:
                    if linked_id not in tool_results:
                        tool_results[linked_id] = []
                    tool_results[linked_id].append(sanitized_msg)
    
    # Second pass: embed tool results into assistant messages and filter out tool messages
    logger.debug(f"[SANITIZER] Total assistant messages: {len(assistant_map)}, Total tool result groups: {len(tool_results)}")
    logger.debug(f"[SANITIZER] Tool results by assistant ID: {list(tool_results.keys())}")
    
    for msg in temp_sanitized:
        if msg['type'] == 'tool':
            # Skip standalone tool messages - they're embedded in assistant
            continue
        
        if msg['type'] == 'assistant':
            # Add tool results to this assistant message's tool_calls
            msg_id = msg['message_id']
            logger.debug(f"[SANITIZER] Processing assistant {msg_id} with {len(msg['content']['tool_calls'])} tool calls")
            if msg_id in tool_results:
                results = tool_results[msg_id]
                logger.debug(f"[SANITIZER] Found {len(results)} tool results for assistant {msg_id}")
                
                # Match each tool result to its tool call by index
                for tool_result in results:
                    tool_idx = tool_result.get('metadata', {}).get('tool_index')
                    logger.debug(f"[SANITIZER] Tool result: idx={tool_idx}, name={tool_result['content']['name']}")
                    
                    # If we have a tool_index, match it to the specific tool call
                    if tool_idx is not None and tool_idx < len(msg['content']['tool_calls']):
                        msg['content']['tool_calls'][tool_idx]['result'] = {
                            'name': tool_result['content']['name'],
                            'result': tool_result['content']['result'],
                            'success': tool_result['content']['success'],
                            'error': tool_result['content'].get('error'),
                            'message_id': tool_result['message_id']
                        }
                        logger.debug(f"[SANITIZER] ✅ Embedded result at index {tool_idx}")
                    # Otherwise, try to match by tool name
                    else:
                        logger.debug(f"[SANITIZER] No tool_index, trying name matching for {tool_result['content']['name']}")
                        tool_name = tool_result['content']['name']
                        for tool_call in msg['content']['tool_calls']:
                            if tool_call['name'] == tool_name and 'result' not in tool_call:
                                tool_call['result'] = {
                                    'name': tool_result['content']['name'],
                                    'result': tool_result['content']['result'],
                                    'success': tool_result['content']['success'],
                                    'error': tool_result['content'].get('error'),
                                    'message_id': tool_result['message_id']
                                }
                                logger.debug(f"[SANITIZER] ✅ Embedded result by name matching for {tool_name}")
                                break
            else:
                logger.debug(f"[SANITIZER] ❌ No tool results found for assistant {msg_id}")
        
        sanitized.append(msg)
    
    return sanitized

