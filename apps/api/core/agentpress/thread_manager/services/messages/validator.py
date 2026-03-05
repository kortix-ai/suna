import json
from typing import Dict, Any
from core.utils.logger import logger


class MessageValidator:
    def validate_message(self, message: Dict[str, Any]) -> Dict[str, Any]:
        if message.get('role') == 'assistant' and message.get('tool_calls'):
            return self.validate_tool_calls(message)
        return message
    
    def validate_tool_calls(self, message: Dict[str, Any]) -> Dict[str, Any]:
        tool_calls = message.get('tool_calls') or []
        if not tool_calls or not isinstance(tool_calls, list):
            return message
        
        valid_tool_calls = []
        needs_normalization = False
        
        for tc in tool_calls:
            if not isinstance(tc, dict):
                continue
            
            func_data = tc.get('function', {})
            args = func_data.get('arguments', '')
            
            if isinstance(args, str):
                try:
                    parsed = json.loads(args)
                    if isinstance(parsed, dict):
                        valid_tool_calls.append(tc)
                    else:
                        logger.warning(f"Removing tool call {tc.get('id')}: arguments not a dict")
                except json.JSONDecodeError as e:
                    logger.warning(f"Removing tool call {tc.get('id')}: invalid JSON - {str(e)[:50]}")
            elif isinstance(args, dict):
                try:
                    normalized_tc = tc.copy()
                    normalized_tc['function'] = tc['function'].copy()
                    normalized_tc['function']['arguments'] = json.dumps(args, ensure_ascii=False)
                    valid_tool_calls.append(normalized_tc)
                    needs_normalization = True
                    logger.debug(f"Normalized tool call {tc.get('id')}: converted dict arguments to JSON string")
                except (TypeError, ValueError) as e:
                    logger.warning(f"Removing tool call {tc.get('id')}: failed to serialize dict arguments - {str(e)[:50]}")
            else:
                logger.warning(f"Removing tool call {tc.get('id')}: unexpected arguments type {type(args)}")
        
        if len(valid_tool_calls) != len(tool_calls) or needs_normalization:
            if len(valid_tool_calls) != len(tool_calls):
                logger.warning(f"Filtered {len(tool_calls) - len(valid_tool_calls)} invalid tool calls from message")
            message = message.copy()
            if valid_tool_calls:
                message['tool_calls'] = valid_tool_calls
            else:
                del message['tool_calls']
        
        return message
