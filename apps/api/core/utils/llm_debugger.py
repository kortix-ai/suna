"""
LLM Debug Logger - Logs INPUT/OUTPUT/DB_WRITE with date-first sorted filenames.

Usage:
    from core.utils.llm_debugger import llm_debug
    
    # Log LLM input
    correlation_id = llm_debug.log_input(model="gpt-4", messages=[...])
    
    # Log LLM output
    llm_debug.log_output(model="gpt-4", content="...", correlation_id=correlation_id)
    
    # Log DB write
    llm_debug.log_db_write(operation="INSERT", table="messages", record_id="...")

Files are saved to debug_streams/ with date-first filenames for proper sorting:
    - 20260122_103045_123456_INPUT.json
    - 20260122_103045_234567_OUTPUT.json
    - 20260122_103045_345678_DB_WRITE.json

Enable with DEBUG_SAVE_LLM_IO=true in config.
"""

import json
import uuid
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

from core.utils.logger import logger


class LLMDebugLogger:
    """
    Centralized debug logger for LLM operations.
    
    Logs are saved to debug_streams/ with date-first filenames for proper sorting.
    Each log includes a correlation_id to track related operations.
    """
    
    _instance = None
    _debug_dir: Path = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._debug_dir = Path("debug_streams")
        return cls._instance
    
    def _is_enabled(self) -> bool:
        """Check if debug logging is enabled (lazy check for config availability)."""
        try:
            from core.utils.config import config
            return config and getattr(config, 'DEBUG_SAVE_LLM_IO', False)
        except ImportError:
            return False
    
    def _get_filename(self, event_type: str) -> str:
        """Generate date-first filename: YYYYMMDD_HHMMSS_microseconds_TYPE.json"""
        now = datetime.now(timezone.utc)
        timestamp = now.strftime("%Y%m%d_%H%M%S")
        micros = now.strftime("%f")[:6]
        return f"{timestamp}_{micros}_{event_type}.json"
    
    def _ensure_dir(self) -> bool:
        """Ensure debug directory exists."""
        try:
            self._debug_dir.mkdir(exist_ok=True)
            return True
        except Exception as e:
            logger.warning(f"[LLM_DEBUG] Failed to create debug dir: {e}")
            return False
    
    def _write_log(self, event_type: str, data: Dict[str, Any]) -> Optional[str]:
        """Write a debug log file. Returns filepath on success."""
        if not self._is_enabled():
            return None
        
        if not self._ensure_dir():
            return None
        
        try:
            filename = self._get_filename(event_type)
            filepath = self._debug_dir / filename
            
            # Add metadata
            data["_event_type"] = event_type
            data["_timestamp"] = datetime.now(timezone.utc).isoformat()
            
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False, default=str)
            
            logger.debug(f"[LLM_DEBUG] Saved {event_type} to: {filename}")
            return str(filepath)
        except Exception as e:
            logger.warning(f"[LLM_DEBUG] Error saving {event_type}: {e}")
            return None
    
    def log_input(
        self,
        model: str,
        messages: List[Dict[str, Any]],
        correlation_id: Optional[str] = None,
        **kwargs
    ) -> Optional[str]:
        """
        Log LLM API call INPUT.
        
        Returns correlation_id for tracking related OUTPUT log.
        """
        corr_id = correlation_id or str(uuid.uuid4())[:8]
        
        if not self._is_enabled():
            return corr_id
        
        data = {
            "correlation_id": corr_id,
            "model": model,
            "messages": messages,
            "message_count": len(messages),
            "parameters": {
                k: v for k, v in kwargs.items() 
                if k in ["temperature", "max_tokens", "stop", "stream", "tools", 
                        "tool_choice", "frequency_penalty", "top_p", "response_format"]
            }
        }
        
        # Add tool names if present
        if kwargs.get("tools"):
            data["tool_names"] = [t.get("function", {}).get("name", "unknown") 
                                  for t in kwargs.get("tools", [])]
        
        self._write_log("INPUT", data)
        return corr_id
    
    def log_output(
        self,
        model: str,
        content: str,
        tool_calls: Optional[List[Dict[str, Any]]] = None,
        finish_reason: Optional[str] = None,
        chunk_count: int = 0,
        duration_seconds: float = 0,
        correlation_id: Optional[str] = None,
        **kwargs
    ) -> None:
        """Log LLM API call OUTPUT (streaming response accumulated)."""
        if not self._is_enabled():
            return
        
        data = {
            "correlation_id": correlation_id or "unknown",
            "model": model,
            "duration_seconds": round(duration_seconds, 2),
            "chunk_count": chunk_count,
            "finish_reason": finish_reason,
            "content": content,
            "content_length": len(content) if content else 0,
        }
        
        if tool_calls:
            data["tool_calls"] = tool_calls
            data["tool_call_count"] = len(tool_calls)
        
        # Add any extra kwargs
        data.update(kwargs)
        
        self._write_log("OUTPUT", data)
    
    def log_db_write(
        self,
        operation: str,
        table: str,
        record_id: Optional[str] = None,
        thread_id: Optional[str] = None,
        message_type: Optional[str] = None,
        content_preview: Optional[str] = None,
        correlation_id: Optional[str] = None,
        **kwargs
    ) -> None:
        """
        Log database write operation.
        
        Args:
            operation: Type of operation (INSERT, UPDATE, DELETE)
            table: Table name (messages, threads, etc.)
            record_id: Primary key of the record
            thread_id: Associated thread ID
            message_type: For messages table - type of message
            content_preview: Truncated preview of content (first 500 chars)
            correlation_id: For linking to LLM INPUT/OUTPUT
        """
        if not self._is_enabled():
            return
        
        data = {
            "correlation_id": correlation_id or "unknown",
            "operation": operation,
            "table": table,
        }
        
        if record_id:
            data["record_id"] = record_id
        if thread_id:
            data["thread_id"] = thread_id
        if message_type:
            data["message_type"] = message_type
        if content_preview:
            # Truncate content preview
            preview = str(content_preview)[:500]
            if len(str(content_preview)) > 500:
                preview += "... [truncated]"
            data["content_preview"] = preview
        
        # Add any extra kwargs
        data.update(kwargs)
        
        self._write_log("DB_WRITE", data)


# Singleton instance
llm_debug = LLMDebugLogger()
