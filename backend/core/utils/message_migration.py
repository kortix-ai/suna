"""
Message Migration Utility

Migrates old message formats to the new unified structure:
- Assistant messages: Extract tool_calls and text_content to metadata
- Tool messages: Extract result to metadata

Can be run:
1. Lazy (on read) - migrate messages when accessed
2. Bulk - migrate all messages in a thread or batch
3. One-time - migrate entire database
"""

import json
import uuid
import re
from typing import Dict, Any, List, Optional
from core.utils.logger import logger
from core.agentpress.xml_tool_parser import strip_xml_tool_calls, parse_xml_tool_calls
from core.utils.json_helpers import safe_json_parse


def needs_migration(message: Dict[str, Any]) -> bool:
    """Check if a message needs migration to new format."""
    msg_type = message.get('type')
    metadata = safe_json_parse(message.get('metadata', '{}'), {})
    content = safe_json_parse(message.get('content', '{}'), {})
    
    if msg_type == 'assistant':
        # Needs migration if missing tool_calls or text_content in metadata
        has_tool_calls = 'tool_calls' in metadata
        has_text_content = 'text_content' in metadata
        
        # Check if content has XML tool calls that need extraction
        content_str = content.get('content', '') if isinstance(content, dict) else str(content)
        has_xml_tool_calls = '<function_calls>' in content_str if isinstance(content_str, str) else False
        
        # Needs migration if:
        # 1. Missing tool_calls in metadata AND has XML tool calls in content
        # 2. Missing text_content in metadata AND has content
        if has_xml_tool_calls and not has_tool_calls:
            return True
        if content_str and not has_text_content:
            return True
            
        # Also check for native tool calls
        native_tool_calls = content.get('tool_calls') if isinstance(content, dict) else None
        if native_tool_calls and not has_tool_calls:
            return True
            
    elif msg_type == 'tool':
        # Needs migration if missing result in metadata OR has frontend_content that needs migration
        if 'result' not in metadata:
            return True
        # Check if frontend_content exists but result structure doesn't match new format
        frontend_content = metadata.get('frontend_content', {})
        if frontend_content and isinstance(frontend_content, dict):
            tool_execution = frontend_content.get('tool_execution')
            if tool_execution and 'result' not in metadata:
                return True
            
    return False


def migrate_assistant_message(message: Dict[str, Any]) -> Dict[str, Any]:
    """
    Migrate an assistant message to new format.
    
    Extracts:
    - tool_calls (from XML or native format) -> metadata.tool_calls
    - text_content (clean text without tool calls) -> metadata.text_content
    
    Generates deterministic tool_call_ids based on message_id + function_name + index
    for better linking with tool messages.
    """
    content = safe_json_parse(message.get('content', '{}'), {})
    metadata = safe_json_parse(message.get('metadata', '{}'), {})
    message_id = message.get('message_id', '')
    
    # Get content string
    content_str = content.get('content', '') if isinstance(content, dict) else str(content)
    if not isinstance(content_str, str):
        content_str = str(content_str)
    
    # Extract clean text
    text_content = strip_xml_tool_calls(content_str)
    if text_content.strip():
        metadata['text_content'] = text_content
    
    # Extract tool calls
    unified_tool_calls = []
    
    # 1. Extract XML tool calls (ALL old messages are XML)
    xml_tool_calls = parse_xml_tool_calls(content_str)
    for idx, xml_tc in enumerate(xml_tool_calls):
        function_name = xml_tc['tool_name'].replace('-', '_')
        xml_tag_name = xml_tc['tool_name']
        
        # Generate tool_call_id matching response_processor.py format EXACTLY
        # Format: xml_tool_index{idx}_{message_id}
        if message_id:
            tool_call_id = f"xml_tool_index{idx}_{message_id}"
        else:
            # Fallback if no message_id (shouldn't happen)
            tool_call_id = f"xml_tool_index{idx}_{str(uuid.uuid4())}"
        
        unified_tool_calls.append({
            "tool_call_id": tool_call_id,
            "function_name": function_name,
            "xml_tag_name": xml_tag_name,
            "arguments": xml_tc['parameters'],
            "source": "xml"
        })
    
    # 2. Extract native tool calls (for newer messages that might have native format)
    native_tool_calls = content.get('tool_calls') if isinstance(content, dict) else None
    if native_tool_calls and isinstance(native_tool_calls, list):
        for idx, tc in enumerate(native_tool_calls):
            if isinstance(tc, dict):
                # Use existing ID if available
                tc_id = tc.get('id')
                if not tc_id:
                    # Generate deterministic tool_call_id for native calls
                    func = tc.get('function', {})
                    func_name = func.get('name', 'unknown')
                    # Use UUID v5 for deterministic generation
                    namespace = uuid.UUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')
                    name = f"{message_id}:{func_name}:{len(xml_tool_calls) + idx}"
                    tc_id = str(uuid.uuid5(namespace, name))
                
                func = tc.get('function', {})
                func_name = func.get('name', 'unknown')
                func_args = func.get('arguments', '{}')
                
                # Parse arguments
                parsed_args = safe_json_parse(func_args, {}) if isinstance(func_args, str) else func_args
                
                unified_tool_calls.append({
                    "tool_call_id": tc_id,
                    "function_name": func_name,
                    "arguments": parsed_args,
                    "source": "native"
                })
    
    if unified_tool_calls:
        metadata['tool_calls'] = unified_tool_calls
    
    return {
        **message,
        'metadata': metadata
    }


def migrate_tool_message(message: Dict[str, Any], assistant_messages: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """
    Migrate a tool message to new format matching response_processor.py structure exactly.
    
    Extracts:
    - result -> metadata.result (ONLY success, output, error - NO function_name or tool_call_id)
    - return_format -> metadata.return_format ("xml" for old messages since all are XML)
    - tool_call_id -> metadata.tool_call_id (stored separately, NOT in result)
    - function_name -> metadata.function_name (stored separately, NOT in result)
    - assistant_message_id -> metadata.assistant_message_id (if not already present)
    
    IMPORTANT: All old thread messages are XML format, so return_format should be "xml"
    
    Args:
        message: Tool message to migrate
        assistant_messages: Optional list of assistant messages to find matching tool_call_id
    """
    content = safe_json_parse(message.get('content', '{}'), {})
    metadata = safe_json_parse(message.get('metadata', '{}'), {})
    message_id = message.get('message_id')
    
    # PREFER frontend_content if available (it has both result and arguments nicely structured)
    frontend_content = metadata.get('frontend_content', {})
    tool_execution = None
    
    if frontend_content and isinstance(frontend_content, dict):
        tool_execution = frontend_content.get('tool_execution')
    
    # Determine return format and extract result
    # ALL old messages are XML, so default to "xml"
    return_format = "xml"
    result_data = None
    function_name = None
    xml_tag_name = None
    
    if tool_execution and isinstance(tool_execution, dict):
        # Use frontend_content.tool_execution - this is the cleanest source
        result_obj = tool_execution.get('result', {})
        function_name = tool_execution.get('function_name', 'unknown')
        xml_tag_name = tool_execution.get('xml_tag_name')
        tool_call_id_from_exec = tool_execution.get('tool_call_id')
        
        # Determine return format based on xml_tag_name presence (old messages are XML)
        if xml_tag_name:
            return_format = "xml"
        else:
            # If no xml_tag_name but we're migrating old message, assume XML
            return_format = "xml"
        
        # Build result structure matching response_processor.py format EXACTLY
        # ONLY success, output, error - NO function_name or tool_call_id
        result_data = {
            "success": result_obj.get('success', True),
            "output": result_obj.get('output', ''),
            "error": result_obj.get('error')
        }
        
        # Store tool_call_id separately in metadata (NOT in result)
        if tool_call_id_from_exec:
            metadata['tool_call_id'] = tool_call_id_from_exec
        
    elif isinstance(content, dict):
        # Check if it's native format (has tool_call_id in content)
        if 'tool_call_id' in content or (content.get('role') == 'tool' and 'tool_call_id' in content):
            # This is native format, but for old messages we still treat as XML
            return_format = "xml"  # Old messages are XML
            function_name = content.get('name', 'unknown')
            content_value = content.get('content', '')
            
            # Parse content if it's a JSON string
            if isinstance(content_value, str):
                try:
                    parsed_content = safe_json_parse(content_value, content_value)
                    if isinstance(parsed_content, dict) and 'tool_execution' in parsed_content:
                        # Extract from tool_execution structure
                        tool_exec = parsed_content['tool_execution']
                        result_obj = tool_exec.get('result', {})
                        function_name = tool_exec.get('function_name', function_name)
                        xml_tag_name = tool_exec.get('xml_tag_name')
                        result_data = {
                            "success": result_obj.get('success', True),
                            "output": result_obj.get('output', ''),
                            "error": result_obj.get('error')
                        }
                    else:
                        result_data = {
                            "success": True,
                            "output": parsed_content,
                            "error": None
                        }
                except:
                    result_data = {
                        "success": True,
                        "output": content_value,
                        "error": None
                    }
            else:
                result_data = {
                    "success": True,
                    "output": content_value,
                    "error": None
                }
            
            # Store tool_call_id separately if available
            if content.get('tool_call_id'):
                metadata['tool_call_id'] = content.get('tool_call_id')
        else:
            # XML format (role="user" with content string containing tool_execution JSON)
            return_format = "xml"
            content_str = content.get('content', '') if isinstance(content, dict) else str(content)
            try:
                parsed = safe_json_parse(content_str, {})
                if isinstance(parsed, dict) and 'tool_execution' in parsed:
                    tool_exec = parsed['tool_execution']
                    function_name = tool_exec.get('function_name', 'unknown')
                    xml_tag_name = tool_exec.get('xml_tag_name')
                    result_obj = tool_exec.get('result', {})
                    # Build result matching response_processor.py format EXACTLY
                    result_data = {
                        "success": result_obj.get('success', True),
                        "output": result_obj.get('output', ''),
                        "error": result_obj.get('error')
                    }
                    if tool_exec.get('tool_call_id'):
                        metadata['tool_call_id'] = tool_exec.get('tool_call_id')
                else:
                    # Fallback: use parsed content directly as output
                    function_name = parsed.get('function_name', 'unknown')
                    result_data = {
                        "success": True,
                        "output": parsed,
                        "error": None
                    }
            except:
                # Fallback: use content as-is
                function_name = "unknown"
                result_data = {
                    "success": True,
                    "output": content_str,
                    "error": None
                }
    else:
        # Content is string or other type - treat as XML (old messages are XML)
        return_format = "xml"
        function_name = "unknown"
        result_data = {
            "success": True,
            "output": str(content),
            "error": None
        }
    
    # Store function_name separately in metadata (NOT in result)
    if function_name and function_name != 'unknown':
        metadata['function_name'] = function_name
    
    # Try to find matching tool_call_id from assistant message
    assistant_message_id = metadata.get('assistant_message_id')
    
    # If we don't have assistant_message_id, try to find it by looking for nearby assistant messages
    if not assistant_message_id and assistant_messages:
        # Find the most recent assistant message before this tool message
        message_created_at = message.get('created_at')
        if message_created_at:
            # Sort assistant messages by created_at descending
            sorted_assistants = sorted(
                [m for m in assistant_messages if m.get('created_at')],
                key=lambda x: x.get('created_at', ''),
                reverse=True
            )
            # Find the first assistant message created before this tool message
            for ass_msg in sorted_assistants:
                if ass_msg.get('created_at', '') < message_created_at:
                    assistant_message_id = ass_msg.get('message_id')
                    metadata['assistant_message_id'] = assistant_message_id
                    break
    
    # Link tool_call_id from assistant message if we have assistant_message_id
    if assistant_message_id and assistant_messages:
        # Find the assistant message
        assistant_msg = next((m for m in assistant_messages if m.get('message_id') == assistant_message_id), None)
        if assistant_msg:
            assistant_metadata = safe_json_parse(assistant_msg.get('metadata', '{}'), {})
            tool_calls = assistant_metadata.get('tool_calls') or []
            if not isinstance(tool_calls, list):
                tool_calls = []
            
            # If we don't have tool_call_id yet, try to match by function name
            if not metadata.get('tool_call_id') and function_name and function_name != 'unknown':
                # Try exact function_name match first
                matching_tc = next((
                    tc for tc in tool_calls 
                    if tc.get('function_name') == function_name
                ), None)
                
                # If no exact match, try xml_tag_name match (for XML tool calls)
                if not matching_tc and xml_tag_name:
                    matching_tc = next((
                        tc for tc in tool_calls 
                        if tc.get('xml_tag_name') == xml_tag_name or
                           tc.get('xml_tag_name') == xml_tag_name.replace('_', '-') or
                           tc.get('function_name') == xml_tag_name.replace('-', '_')
                    ), None)
                
                if matching_tc:
                    tool_call_id = matching_tc.get('tool_call_id')
                    metadata['tool_call_id'] = tool_call_id
            
            # If still no tool_call_id and there's only one tool call, use it
            if not metadata.get('tool_call_id') and len(tool_calls) == 1:
                tool_call_id = tool_calls[0].get('tool_call_id')
                if tool_call_id:
                    metadata['tool_call_id'] = tool_call_id
            
            # If still no match and we have multiple tool calls with same function_name, use first match
            if not metadata.get('tool_call_id') and function_name and function_name != 'unknown':
                # Find all tool calls matching function_name
                matching_tool_calls = [
                    tc for tc in tool_calls 
                    if tc.get('function_name') == function_name or
                       (xml_tag_name and tc.get('xml_tag_name') == xml_tag_name)
                ]
                if len(matching_tool_calls) == 1:
                    # Only one match, use it
                    tool_call_id = matching_tool_calls[0].get('tool_call_id')
                    if tool_call_id:
                        metadata['tool_call_id'] = tool_call_id
                elif len(matching_tool_calls) > 1:
                    # Multiple matches - use first one (best effort)
                    tool_call_id = matching_tool_calls[0].get('tool_call_id')
                    if tool_call_id:
                        metadata['tool_call_id'] = tool_call_id
    
    # Generate tool_call_id if still missing (matching response_processor.py format)
    if not metadata.get('tool_call_id') and assistant_message_id and function_name:
        # Try to find index by matching function_name in assistant message tool_calls
        if assistant_messages:
            assistant_msg = next((m for m in assistant_messages if m.get('message_id') == assistant_message_id), None)
            if assistant_msg:
                assistant_metadata = safe_json_parse(assistant_msg.get('metadata', '{}'), {})
                tool_calls = assistant_metadata.get('tool_calls') or []
                if not isinstance(tool_calls, list):
                    tool_calls = []
                # Find index of matching tool call
                for idx, tc in enumerate(tool_calls):
                    if tc.get('function_name') == function_name or (xml_tag_name and tc.get('xml_tag_name') == xml_tag_name):
                        # Use XML format: xml_tool_index{idx}_{assistant_message_id}
                        if return_format == "xml":
                            tool_call_id = f"xml_tool_index{idx}_{assistant_message_id}"
                        else:
                            # Native format: use UUID v5
                            namespace = uuid.UUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')
                            name = f"{assistant_message_id}:{function_name}:{idx}"
                            tool_call_id = str(uuid.uuid5(namespace, name))
                        metadata['tool_call_id'] = tool_call_id
                        break
                else:
                    # No match found, use index 0
                    if return_format == "xml":
                        tool_call_id = f"xml_tool_index0_{assistant_message_id}"
                    else:
                        namespace = uuid.UUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')
                        name = f"{assistant_message_id}:{function_name}:0"
                        tool_call_id = str(uuid.uuid5(namespace, name))
                    metadata['tool_call_id'] = tool_call_id
            else:
                # No assistant message found, use index 0
                if return_format == "xml":
                    tool_call_id = f"xml_tool_index0_{assistant_message_id}"
                else:
                    namespace = uuid.UUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')
                    name = f"{assistant_message_id}:{function_name}:0"
                    tool_call_id = str(uuid.uuid5(namespace, name))
                metadata['tool_call_id'] = tool_call_id
    
    # Store result in metadata (matching response_processor.py structure EXACTLY)
    # result should ONLY contain success, output, error - NO function_name or tool_call_id
    if result_data:
        # Ensure result_data only has the three allowed fields
        metadata['result'] = {
            "success": result_data.get('success', True),
            "output": result_data.get('output', ''),
            "error": result_data.get('error')
        }
    metadata['return_format'] = return_format
    
    # CLEAN UP: Remove old fields that shouldn't be in the new structure
    # Keep only: result, tool_call_id, function_name, return_format, assistant_message_id
    cleaned_metadata = {
        'result': metadata.get('result'),
        'tool_call_id': metadata.get('tool_call_id'),
        'function_name': metadata.get('function_name'),
        'return_format': metadata.get('return_format'),
        'assistant_message_id': metadata.get('assistant_message_id')
    }
    # Remove None values
    cleaned_metadata = {k: v for k, v in cleaned_metadata.items() if v is not None}
    
    return {
        **message,
        'metadata': cleaned_metadata
    }


def migrate_message(message: Dict[str, Any], assistant_messages: Optional[List[Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
    """
    Migrate a single message to new format if needed.
    
    Returns:
        Migrated message dict, or None if no migration needed
    """
    if not needs_migration(message):
        return None
    
    msg_type = message.get('type')
    
    if msg_type == 'assistant':
        return migrate_assistant_message(message)
    elif msg_type == 'tool':
        return migrate_tool_message(message, assistant_messages)
    
    return None


async def migrate_thread_messages(client, thread_id: str, save: bool = False) -> Dict[str, int]:
    """
    Migrate all messages in a thread.
    
    Args:
        client: Database client
        thread_id: Thread ID to migrate
        save: If True, save migrated messages back to database
        
    Returns:
        Dict with migration stats: {'migrated': count, 'skipped': count, 'errors': count}
    """
    stats = {'migrated': 0, 'skipped': 0, 'errors': 0}
    
    try:
        # Fetch all messages for thread
        all_messages = []
        batch_size = 1000
        offset = 0
        
        while True:
            result = await client.table('messages').select('*').eq('thread_id', thread_id).order('created_at').range(offset, offset + batch_size - 1).execute()
            if not result.data:
                break
            all_messages.extend(result.data)
            if len(result.data) < batch_size:
                break
            offset += batch_size
        
        # Separate assistant and tool messages
        assistant_messages = [m for m in all_messages if m.get('type') == 'assistant']
        tool_messages = [m for m in all_messages if m.get('type') == 'tool']
        other_messages = [m for m in all_messages if m.get('type') not in ['assistant', 'tool']]
        
        # Migrate assistant messages first
        for msg in assistant_messages:
            try:
                migrated = migrate_message(msg)
                if migrated:
                    if save:
                        await client.table('messages').update({
                            'metadata': migrated['metadata']
                        }).eq('message_id', msg['message_id']).execute()
                    stats['migrated'] += 1
                else:
                    stats['skipped'] += 1
            except Exception as e:
                logger.error(f"Error migrating assistant message {msg.get('message_id')}: {e}")
                stats['errors'] += 1
        
        # Migrate tool messages (with access to assistant messages for matching)
        for msg in tool_messages:
            try:
                migrated = migrate_message(msg, assistant_messages)
                if migrated:
                    if save:
                        await client.table('messages').update({
                            'metadata': migrated['metadata']
                        }).eq('message_id', msg['message_id']).execute()
                    stats['migrated'] += 1
                else:
                    stats['skipped'] += 1
            except Exception as e:
                logger.error(f"Error migrating tool message {msg.get('message_id')}: {e}")
                stats['errors'] += 1
        
        logger.info(f"Migration complete for thread {thread_id}: {stats}")
        return stats
        
    except Exception as e:
        logger.error(f"Error migrating thread {thread_id}: {e}")
        stats['errors'] += 1
        return stats

