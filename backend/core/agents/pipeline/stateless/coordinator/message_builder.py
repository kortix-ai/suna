import json
import uuid
from typing import Dict, Any, Optional, List, Tuple
from datetime import datetime, timezone

from core.utils.logger import logger

def _transform_mcp_tool_call(func_name: str, args: Any) -> Tuple[str, Any]:
    if func_name != 'execute_mcp_tool':
        return func_name, args
    
    parsed_args = args
    if isinstance(args, str):
        try:
            parsed_args = json.loads(args)
        except json.JSONDecodeError:
            return func_name, args
    
    if not isinstance(parsed_args, dict):
        return func_name, args
    
    tool_name = parsed_args.get('tool_name')
    real_args = parsed_args.get('args', {})
    
    if tool_name:
        logger.debug(f"🎭 [MCP TRANSFORM] execute_mcp_tool -> {tool_name}")
        return tool_name, real_args
    
    return func_name, args

class MessageBuilder:
    def __init__(self, increment_sequence, get_thread_id, get_thread_run_id, get_agent_id=None):
        self._increment_sequence = increment_sequence
        self._get_thread_id = get_thread_id
        self._get_thread_run_id = get_thread_run_id
        self._get_agent_id = get_agent_id

    def build_thread_run_start(self, stream_start: str) -> Dict[str, Any]:
        return {
            "message_id": None,
            "thread_id": self._get_thread_id(),
            "type": "status",
            "is_llm_message": False,
            "content": json.dumps({"status_type": "thread_run_start"}),
            "metadata": json.dumps({"thread_run_id": self._get_thread_run_id()}),
            "created_at": stream_start,
            "updated_at": stream_start
        }

    def build_llm_response_start(self, llm_response_id: str, auto_continue_count: int, model: str, stream_start: str) -> Dict[str, Any]:
        return {
            "message_id": None,
            "thread_id": self._get_thread_id(),
            "type": "llm_response_start",
            "is_llm_message": False,
            "content": json.dumps({
                "llm_response_id": llm_response_id,
                "auto_continue_count": auto_continue_count,
                "model": model,
                "timestamp": stream_start
            }),
            "metadata": json.dumps({
                "thread_run_id": self._get_thread_run_id(),
                "llm_response_id": llm_response_id
            }),
            "created_at": stream_start,
            "updated_at": stream_start
        }

    def build_llm_response_end(self) -> Dict[str, Any]:
        return {
            "type": "llm_response_end",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "thread_run_id": self._get_thread_run_id()
        }

    def build_content_chunk(self, content: str, stream_start: str) -> Dict[str, Any]:
        seq = self._increment_sequence()
        return {
            "sequence": seq,
            "message_id": None,
            "thread_id": self._get_thread_id(),
            "type": "assistant",
            "is_llm_message": True,
            "content": json.dumps({"role": "assistant", "content": content}),
            "metadata": json.dumps({
                "stream_status": "chunk",
                "thread_run_id": self._get_thread_run_id()
            }),
            "created_at": stream_start,
            "updated_at": stream_start
        }

    def build_assistant_complete(
        self, 
        message_id: str, 
        content: str, 
        tool_calls: Optional[List[Dict[str, Any]]], 
        stream_start: str
    ) -> Dict[str, Any]:
        unified_tool_calls = []
        transformed_tool_calls = []
        
        if tool_calls:
            for tc in tool_calls:
                func_name = tc.get("function", {}).get("name", "")
                args_str = tc.get("function", {}).get("arguments", "{}")
                try:
                    args_parsed = json.loads(args_str) if isinstance(args_str, str) else args_str
                except:
                    args_parsed = args_str
                
                display_name, display_args = _transform_mcp_tool_call(func_name, args_parsed)
                
                unified_tool_calls.append({
                    "source": "native",
                    "arguments": display_args,
                    "tool_call_id": tc.get("id"),
                    "function_name": display_name,
                    "_original_function_name": func_name if func_name != display_name else None
                })
                
                transformed_tc = tc.copy()
                if func_name != display_name:
                    transformed_tc["function"] = {
                        "name": display_name,
                        "arguments": json.dumps(display_args) if not isinstance(display_args, str) else display_args
                    }
                transformed_tool_calls.append(transformed_tc)
        
        metadata = {
            "text_content": content or "",
            "thread_run_id": self._get_thread_run_id(),
            "stream_status": "complete"
        }
        if unified_tool_calls:
            metadata["tool_calls"] = unified_tool_calls
        
        inner_content = {"role": "assistant", "content": content or ""}
        if transformed_tool_calls:
            inner_content["tool_calls"] = transformed_tool_calls

        agent_id = self._get_agent_id() if self._get_agent_id else None
        seq = self._increment_sequence()

        return {
            "sequence": seq,
            "message_id": message_id,
            "thread_id": self._get_thread_id(),
            "type": "assistant",
            "is_llm_message": True,
            "content": json.dumps(inner_content),
            "metadata": json.dumps(metadata),
            "created_at": stream_start,
            "updated_at": stream_start,
            "agent_id": agent_id,
            "agent_version_id": None,
            "created_by_user_id": None
        }

    def build_tool_call_chunk(
        self, 
        tool_call_buffer: Dict[int, Dict], 
        stream_start: str, 
        sent_lengths: Dict[int, int]
    ) -> Optional[Dict[str, Any]]:
        tool_calls_list = []
        for idx in sorted(tool_call_buffer.keys()):
            tc = tool_call_buffer[idx]
            func = tc.get("function", {})
            name = func.get("name", "")
            args = func.get("arguments", "")
            
            if not name:
                continue
            
            prev_length = sent_lengths.get(idx, 0)
            current_length = len(args)
            
            if current_length > prev_length:
                args_delta = args[prev_length:]
                sent_lengths[idx] = current_length
                
                display_name = name
                display_args_delta = args_delta
                
                if name == 'execute_mcp_tool' and args:
                    try:
                        full_args = json.loads(args)
                        if isinstance(full_args, dict) and full_args.get('tool_name'):
                            display_name = full_args['tool_name']
                            real_args = full_args.get('args', {})
                            if real_args:
                                display_args_delta = json.dumps(real_args)[prev_length:] if prev_length > 0 else json.dumps(real_args)
                    except json.JSONDecodeError:
                        pass
                
                tool_calls_list.append({
                    "tool_call_id": tc.get("id", f"streaming_tool_{idx}"),
                    "function_name": display_name,
                    "arguments_delta": display_args_delta,
                    "is_delta": True,
                    "source": "native"
                })
        
        if not tool_calls_list:
            return None
        
        seq = self._increment_sequence()
        return {
            "sequence": seq,
            "message_id": None,
            "thread_id": self._get_thread_id(),
            "type": "assistant",
            "is_llm_message": True,
            "content": json.dumps({"role": "assistant", "content": ""}),
            "metadata": json.dumps({
                "thread_run_id": self._get_thread_run_id(),
                "stream_status": "tool_call_chunk",
                "tool_calls": tool_calls_list
            }),
            "created_at": stream_start,
            "updated_at": stream_start
        }

    def build_tool_started(self, tc_id: str, name: str, index: int, stream_start: str, args: Any = None) -> Dict[str, Any]:
        display_name = name
        if name == 'execute_mcp_tool' and args:
            display_name, _ = _transform_mcp_tool_call(name, args)
        
        return {
            "message_id": str(uuid.uuid4()),
            "thread_id": self._get_thread_id(),
            "type": "status",
            "is_llm_message": False,
            "content": json.dumps({
                "tool_index": index,
                "status_type": "tool_started",
                "tool_call_id": tc_id,
                "function_name": display_name
            }),
            "metadata": json.dumps({"thread_run_id": self._get_thread_run_id()}),
            "created_at": stream_start,
            "updated_at": stream_start,
            "agent_id": None,
            "agent_version_id": None,
            "created_by_user_id": None
        }

    def build_tool_result(
        self, 
        tc_id: str, 
        name: str, 
        output: Any, 
        success: bool, 
        error: Optional[str], 
        index: int, 
        stream_start: str, 
        assistant_message_id: Optional[str] = None
    ) -> Dict[str, Any]:
        raw_output = output
        if hasattr(output, 'output'):
            raw_output = output.output
        
        if isinstance(raw_output, str):
            content_value = raw_output
        elif raw_output is None:
            content_value = ""
        else:
            try:
                content_value = json.dumps(raw_output)
            except (TypeError, ValueError):
                content_value = str(raw_output)
        
        content = {
            "name": name,
            "role": "tool",
            "content": content_value,
            "tool_call_id": tc_id
        }
        
        message_id = str(uuid.uuid4())
        
        output_for_metadata = raw_output
        if isinstance(raw_output, str):
            try:
                output_for_metadata = json.loads(raw_output)
            except:
                output_for_metadata = raw_output
        
        metadata = {
            "result": {
                "error": error,
                "output": output_for_metadata,
                "success": success
            },
            "tool_call_id": tc_id,
            "function_name": name,
            "return_format": "native"
        }
        if assistant_message_id:
            metadata["assistant_message_id"] = assistant_message_id
        
        seq = self._increment_sequence()
        return {
            "sequence": seq,
            "message_id": message_id,
            "thread_id": self._get_thread_id(),
            "type": "tool",
            "is_llm_message": True,
            "content": json.dumps(content),
            "metadata": json.dumps(metadata),
            "created_at": stream_start,
            "updated_at": stream_start,
            "agent_id": None,
            "agent_version_id": None,
            "created_by_user_id": None
        }

    def build_tool_completed(
        self, 
        tc_id: str, 
        name: str, 
        success: bool, 
        index: int, 
        stream_start: str, 
        linked_message_id: Optional[str] = None,
        is_terminating: bool = False
    ) -> Dict[str, Any]:
        status_type = "tool_completed" if success else "tool_failed"
        content = {
            "tool_index": index,
            "status_type": status_type,
            "tool_call_id": tc_id,
            "function_name": name
        }
        
        metadata = {"thread_run_id": self._get_thread_run_id()}
        if is_terminating and success:
            metadata["agent_should_terminate"] = True
            content["finish_reason"] = "agent_terminated"
        if linked_message_id:
            metadata["linked_tool_result_message_id"] = linked_message_id

        return {
            "message_id": str(uuid.uuid4()),
            "thread_id": self._get_thread_id(),
            "type": "status",
            "is_llm_message": False,
            "content": json.dumps(content),
            "metadata": json.dumps(metadata),
            "created_at": stream_start,
            "updated_at": stream_start,
            "agent_id": None,
            "agent_version_id": None,
            "created_by_user_id": None
        }

    def build_finish_message(self, finish_reason: str, tools_executed: bool = False) -> Dict[str, Any]:
        content = {"status_type": "finish", "finish_reason": finish_reason}
        if tools_executed:
            content["tools_executed"] = True

        return {
            "message_id": str(uuid.uuid4()),
            "thread_id": self._get_thread_id(),
            "type": "status",
            "is_llm_message": False,
            "content": json.dumps(content),
            "metadata": json.dumps({"thread_run_id": self._get_thread_run_id()}),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "agent_id": None,
            "agent_version_id": None,
            "created_by_user_id": None
        }

    def build_termination_message(self) -> Dict[str, Any]:
        return {
            "message_id": str(uuid.uuid4()),
            "thread_id": self._get_thread_id(),
            "type": "status",
            "is_llm_message": False,
            "content": json.dumps({"status_type": "finish", "finish_reason": "agent_terminated"}),
            "metadata": json.dumps({
                "thread_run_id": self._get_thread_run_id(),
                "agent_should_terminate": True
            }),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "agent_id": None,
            "agent_version_id": None,
            "created_by_user_id": None
        }

    def build_terminating_tool_status(self, tc_id: str, tool_name: str) -> Dict[str, Any]:
        return {
            "message_id": str(uuid.uuid4()),
            "thread_id": self._get_thread_id(),
            "type": "status",
            "is_llm_message": False,
            "content": json.dumps({
                "status_type": "terminating_tool_completed",
                "tool_call_id": tc_id,
                "function_name": tool_name
            }),
            "metadata": json.dumps({"thread_run_id": self._get_thread_run_id()}),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "agent_id": None,
            "agent_version_id": None,
            "created_by_user_id": None
        }

    def build_status_message(self, status: str, message: str) -> Dict[str, Any]:
        return {
            "type": "status",
            "status": status,
            "message": message
        }

    def build_llm_ttft(self, ttft_seconds: float, model: str, thread_id: str) -> Dict[str, Any]:
        return {
            "type": "llm_ttft",
            "ttft_seconds": ttft_seconds,
            "model": model,
            "thread_id": thread_id
        }
