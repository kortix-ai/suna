from typing import List, Set, Optional
from ..types import ContextChunk, ImportanceLevel
from core.utils.logger import logger


class ImportanceMarker:
    
    def __init__(self):
        self._llm_important_ids: Set[str] = set()
    
    def set_important_message_ids(self, message_ids: List[str]):
        self._llm_important_ids = set(message_ids)
    
    def clear(self):
        self._llm_important_ids = set()
    
    def mark(self, chunks: List[ContextChunk]) -> List[ContextChunk]:
        has_llm_importance = len(self._llm_important_ids) > 0
        
        logger.debug(f"[CONTEXT_ENGINE] ImportanceMarker: Marking {len(chunks)} chunks (LLM importance: {has_llm_importance})")
        
        pinned_count = 0
        high_count = 0
        
        for chunk in chunks:
            role = chunk.metadata.get("role", "")
            message_id = chunk.message_id
            
            if has_llm_importance and message_id and message_id in self._llm_important_ids:
                chunk.importance = ImportanceLevel.PINNED
                pinned_count += 1
            elif role == "system":
                chunk.importance = ImportanceLevel.HIGH
                high_count += 1
            elif role == "user":
                if has_llm_importance:
                    chunk.importance = ImportanceLevel.NORMAL
                else:
                    chunk.importance = self._heuristic_importance(chunk)
                    if chunk.importance == ImportanceLevel.PINNED:
                        pinned_count += 1
                    elif chunk.importance == ImportanceLevel.HIGH:
                        high_count += 1
            else:
                chunk.importance = ImportanceLevel.NORMAL
        
        logger.debug(f"[CONTEXT_ENGINE] ImportanceMarker: {pinned_count} pinned, {high_count} high")
        
        return chunks
    
    def _heuristic_importance(self, chunk: ContextChunk) -> ImportanceLevel:
        content = chunk.content.strip().lower() if chunk.content else ""
        
        if len(content) < 15:
            trivial_phrases = [
                "ok", "okay", "thanks", "thank you", "got it", "yes", "no",
                "sure", "alright", "cool", "great", "nice", "good", "fine",
                "yep", "nope", "yup", "yeah", "nah", "k", "kk", "ty", "thx",
            ]
            if content in trivial_phrases or content.rstrip("!.?") in trivial_phrases:
                return ImportanceLevel.NORMAL
        
        high_importance_markers = [
            "remember", "don't forget", "important", "note this", "save this",
            "my name", "i am", "i'm", "api key", "password", "token", "secret",
            "credential", "deadline", "budget", "must", "critical", "urgent",
        ]
        if any(marker in content for marker in high_importance_markers):
            return ImportanceLevel.PINNED
        
        return ImportanceLevel.HIGH
