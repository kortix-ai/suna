import json
from typing import Optional
from ..types import ContextChunk
from ..utils.tokens import count_tokens
from core.utils.logger import logger


class Compressor:
    def __init__(
        self,
        light_max_tokens: int = 800,
        heavy_max_tokens: int = 300,
        extreme_max_tokens: int = 100,
    ):
        self.light_max_tokens = light_max_tokens
        self.heavy_max_tokens = heavy_max_tokens
        self.extreme_max_tokens = extreme_max_tokens
    
    async def compress_light(self, chunk: ContextChunk) -> ContextChunk:
        if chunk.tokens <= self.light_max_tokens:
            return chunk
        
        role = chunk.metadata.get("role", "")
        
        if role == "tool" or chunk.metadata.get("tool_call_id"):
            content = self._compress_tool_output(chunk.content, self.light_max_tokens)
        else:
            content = self._truncate_smart(chunk.content, self.light_max_tokens)
        
        new_tokens = count_tokens(content)
        
        return ContextChunk(
            content=content,
            source=chunk.source,
            tokens=new_tokens,
            priority=chunk.priority,
            created_at=chunk.created_at,
            message_id=chunk.message_id,
            embedding=chunk.embedding,
            metadata={**chunk.metadata, "compressed": True, "original_tokens": chunk.tokens},
            layer=chunk.layer,
            relevance_score=chunk.relevance_score,
            importance=chunk.importance,
            tool_call_group_id=chunk.tool_call_group_id,
        )
    
    async def compress_heavy(self, chunk: ContextChunk) -> ContextChunk:
        if chunk.tokens <= self.heavy_max_tokens:
            return chunk
        
        role = chunk.metadata.get("role", "")
        
        if role == "tool" or chunk.metadata.get("tool_call_id"):
            content = self._compress_tool_output(chunk.content, self.heavy_max_tokens)
        elif role == "assistant":
            content = self._compress_assistant(chunk.content, self.heavy_max_tokens)
        else:
            content = self._truncate_smart(chunk.content, self.heavy_max_tokens)
        
        new_tokens = count_tokens(content)
        
        return ContextChunk(
            content=content,
            source=chunk.source,
            tokens=new_tokens,
            priority=chunk.priority * 0.9,
            created_at=chunk.created_at,
            message_id=chunk.message_id,
            embedding=chunk.embedding,
            metadata={**chunk.metadata, "compressed": True, "compression_level": "heavy", "original_tokens": chunk.tokens},
            layer=chunk.layer,
            relevance_score=chunk.relevance_score,
            importance=chunk.importance,
            tool_call_group_id=chunk.tool_call_group_id,
        )
    
    def _truncate_smart(self, text: str, max_tokens: int) -> str:
        current_tokens = count_tokens(text)
        if current_tokens <= max_tokens:
            return text
        
        ratio = max_tokens / current_tokens
        target_chars = int(len(text) * ratio * 0.9)
        
        keep_start = target_chars // 2
        keep_end = target_chars - keep_start
        
        return text[:keep_start] + "\n...[truncated]...\n" + text[-keep_end:]
    
    def _compress_tool_output(self, content: str, max_tokens: int) -> str:
        try:
            data = json.loads(content)
            return self._compress_json(data, max_tokens)
        except (json.JSONDecodeError, TypeError):
            return self._truncate_smart(content, max_tokens)
    
    def _compress_json(self, data, max_tokens: int) -> str:
        if isinstance(data, dict):
            if "success" in data:
                parts = [f"Success: {data.get('success', 'unknown')}"]
                if "error" in data and data["error"]:
                    parts.append(f"Error: {data['error']}")
                if "output" in data:
                    output = str(data["output"])
                    output_tokens = count_tokens(output)
                    if output_tokens > max_tokens // 2:
                        output = self._truncate_smart(output, max_tokens // 2)
                    parts.append(f"Output: {output}")
                result = "\n".join(parts)
            elif "error" in data:
                result = f"Error: {data['error']}"
            else:
                keys = list(data.keys())[:5]
                parts = []
                for key in keys:
                    value = str(data[key])
                    if len(value) > 200:
                        value = value[:200] + "..."
                    parts.append(f"{key}: {value}")
                result = "\n".join(parts)
        else:
            result = str(data)
        
        if count_tokens(result) > max_tokens:
            result = self._truncate_smart(result, max_tokens)
        
        return result
    
    def _compress_assistant(self, content: str, max_tokens: int) -> str:
        lines = content.split("\n")
        
        markers = [
            "i will", "i'll", "let me", "i found", "i created",
            "completed", "done", "finished", "error", "failed",
            "success", "result", "next", "now",
        ]
        
        important_lines = []
        for line in lines:
            line_lower = line.lower()
            if any(marker in line_lower for marker in markers):
                important_lines.append(line)
            elif line.strip().startswith(("-", "*", "•", "1.", "2.")):
                important_lines.append(line)
        
        if important_lines:
            result = "\n".join(important_lines)
            if count_tokens(result) <= max_tokens:
                return result
        
        return self._truncate_smart(content, max_tokens)
