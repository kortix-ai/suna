from typing import List, Optional, Tuple
import math
from core.utils.logger import logger
from core.memory.embedding_service import embedding_service

BATCH_SIZE = 50
MAX_TEXT_LENGTH = 8000

async def get_embedding(text: str) -> Optional[List[float]]:
    if not text or not text.strip():
        return None
    
    text = text[:MAX_TEXT_LENGTH]
    
    try:
        return await embedding_service.embed_text(text)
    except Exception as e:
        logger.warning(f"Embedding generation failed: {e}")
        return None


async def get_embeddings_batch(texts: List[str]) -> List[Optional[List[float]]]:
    if not texts:
        return []
    
    results: List[Optional[List[float]]] = [None] * len(texts)
    texts_to_embed: List[Tuple[int, str]] = []
    
    for i, text in enumerate(texts):
        if not text or not text.strip():
            continue
        texts_to_embed.append((i, text[:MAX_TEXT_LENGTH]))
    
    if not texts_to_embed:
        return results
    
    for batch_start in range(0, len(texts_to_embed), BATCH_SIZE):
        batch = texts_to_embed[batch_start:batch_start + BATCH_SIZE]
        batch_texts = [t[1] for t in batch]
        
        try:
            embeddings = await embedding_service.embed_texts(batch_texts)
            
            for j, (original_idx, _) in enumerate(batch):
                if j < len(embeddings):
                    results[original_idx] = embeddings[j]
        except Exception as e:
            logger.warning(f"Batch embedding failed: {e}")
    
    return results


def cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
    if not vec1 or not vec2 or len(vec1) != len(vec2):
        return 0.0
    
    dot_product = sum(a * b for a, b in zip(vec1, vec2))
    norm1 = math.sqrt(sum(a * a for a in vec1))
    norm2 = math.sqrt(sum(b * b for b in vec2))
    
    if norm1 == 0 or norm2 == 0:
        return 0.0
    
    return dot_product / (norm1 * norm2)


def normalize_similarity(similarity: float) -> float:
    return (similarity + 1) / 2
