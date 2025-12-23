from typing import List
from ..types import ContextChunk, ImportanceLevel


class ImportanceMarker:
    
    def mark(self, chunks: List[ContextChunk]) -> List[ContextChunk]:
        for chunk in chunks:
            role = chunk.metadata.get("role", "")
            
            if role == "user":
                chunk.importance = ImportanceLevel.PINNED
            elif role == "system":
                chunk.importance = ImportanceLevel.HIGH
            else:
                chunk.importance = ImportanceLevel.NORMAL
        
        return chunks
