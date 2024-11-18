import json
from typing import Dict, Any, Optional
from agentpress.base_processors import ToolParserBase

# --- Standard Tool Parser Implementation ---

class StandardToolParser(ToolParserBase):
    """Standard implementation of tool parsing for OpenAI-compatible API responses.
    
    This implementation handles the parsing of tool calls from responses that follow
    the OpenAI API format, supporting both complete and streaming responses.
    
    Methods:
        parse_response: Process complete LLM responses
        parse_stream: Handle streaming response chunks
    """
    
    async def parse_response(self, response: Any) -> Dict[str, Any]:
        response_message = response.choices[0].message
        message = {
            "role": "assistant",
            "content": response_message.get('content') or "",
        }
        
        tool_calls = response_message.get('tool_calls')
        if tool_calls:
            message["tool_calls"] = [
                {
                    "id": tool_call.id,
                    "type": "function",
                    "function": {
                        "name": tool_call.function.name,
                        "arguments": tool_call.function.arguments
                    }
                } for tool_call in tool_calls
            ]
        
        return message

    async def parse_stream(self, chunk: Any, tool_calls_buffer: Dict[int, Dict]) -> tuple[Optional[Dict[str, Any]], bool]:
        content_chunk = ""
        is_complete = False
        has_complete_tool_call = False
        
        if hasattr(chunk.choices[0], 'delta'):
            delta = chunk.choices[0].delta
            
            if hasattr(delta, 'content') and delta.content:
                content_chunk = delta.content

            if hasattr(delta, 'tool_calls') and delta.tool_calls:
                for tool_call in delta.tool_calls:
                    idx = tool_call.index
                    if idx not in tool_calls_buffer:
                        tool_calls_buffer[idx] = {
                            'id': tool_call.id if hasattr(tool_call, 'id') and tool_call.id else None,
                            'type': 'function',
                            'function': {
                                'name': tool_call.function.name if hasattr(tool_call.function, 'name') and tool_call.function.name else None,
                                'arguments': ''
                            }
                        }
                    
                    current_tool = tool_calls_buffer[idx]
                    if hasattr(tool_call, 'id') and tool_call.id:
                        current_tool['id'] = tool_call.id
                    if hasattr(tool_call.function, 'name') and tool_call.function.name:
                        current_tool['function']['name'] = tool_call.function.name
                    if hasattr(tool_call.function, 'arguments') and tool_call.function.arguments:
                        current_tool['function']['arguments'] += tool_call.function.arguments
                    
                    if (current_tool['id'] and 
                        current_tool['function']['name'] and 
                        current_tool['function']['arguments']):
                        try:
                            json.loads(current_tool['function']['arguments'])
                            has_complete_tool_call = True
                        except json.JSONDecodeError:
                            pass

        if hasattr(chunk.choices[0], 'finish_reason') and chunk.choices[0].finish_reason:
            is_complete = True

        if has_complete_tool_call or is_complete:
            complete_tool_calls = []
            for idx, tool_call in tool_calls_buffer.items():
                try:
                    if (tool_call['id'] and 
                        tool_call['function']['name'] and 
                        tool_call['function']['arguments']):
                        json.loads(tool_call['function']['arguments'])
                        complete_tool_calls.append(tool_call)
                except json.JSONDecodeError:
                    continue
            
            if complete_tool_calls:
                return {
                    "role": "assistant",
                    "content": content_chunk,
                    "tool_calls": complete_tool_calls
                }, is_complete

        return None, is_complete
