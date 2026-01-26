"""
Thread Semantic Search Service

Provides vector-based semantic search for threads using OpenAI embeddings and Supabase pgvector.
"""

import os
import json
import uuid
from typing import List, Optional, Tuple

from dotenv import load_dotenv

load_dotenv()

from core.utils.logger import logger


# Chunk configuration
CHUNK_SIZE = 1200
CHUNK_OVERLAP = 100


class RecursiveCharacterTextSplitter:
    """
    Recursively splits text using a hierarchy of separators.
    Prioritizes keeping User:/Assistant: message boundaries intact.
    """

    def __init__(
        self,
        chunk_size: int = 1200,
        chunk_overlap: int = 100,
        separators: List[str] = None
    ):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.separators = separators or [
            "\n\nUser: ",
            "\n\nAssistant: ",
            "\n\n",
            "\n",
            ". ",
            "? ",
            "! ",
            "; ",
            ", ",
            " ",
            ""
        ]

    def split_text(self, text: str) -> List[str]:
        """Split text into chunks respecting message boundaries."""
        if not text:
            return []
        if len(text) <= self.chunk_size:
            return [text.strip()] if text.strip() else []
        return self._split_recursive(text, self.separators)

    def _split_recursive(self, text: str, separators: List[str]) -> List[str]:
        """Recursively split text using the separator hierarchy."""
        final_chunks = []
        separator = separators[-1]
        new_separators = []

        for i, sep in enumerate(separators):
            if sep == "":
                separator = sep
                new_separators = []
                break
            if sep in text:
                separator = sep
                new_separators = separators[i + 1:]
                break

        if separator:
            splits = text.split(separator)
            splits = [s + separator if i < len(splits) - 1 else s
                     for i, s in enumerate(splits)]
        else:
            splits = list(text)

        current_chunk = ""

        for split in splits:
            split = split.strip() if not separator else split
            if not split:
                continue

            if len(current_chunk) + len(split) > self.chunk_size:
                if current_chunk.strip():
                    final_chunks.append(current_chunk.strip())

                if len(split) > self.chunk_size:
                    if new_separators:
                        sub_chunks = self._split_recursive(split, new_separators)
                        final_chunks.extend(sub_chunks)
                        current_chunk = ""
                    else:
                        for i in range(0, len(split), self.chunk_size - self.chunk_overlap):
                            chunk = split[i:i + self.chunk_size].strip()
                            if chunk:
                                final_chunks.append(chunk)
                        current_chunk = ""
                else:
                    if final_chunks and self.chunk_overlap > 0:
                        overlap_text = final_chunks[-1][-self.chunk_overlap:]
                        current_chunk = overlap_text + " " + split
                    else:
                        current_chunk = split
            else:
                current_chunk += split

        if current_chunk.strip():
            final_chunks.append(current_chunk.strip())

        return [c for c in final_chunks if c]


# Global splitter instance
text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=CHUNK_SIZE,
    chunk_overlap=CHUNK_OVERLAP
)


class SearchResult:
    """A single search result with thread_id, relevance score, and text preview."""

    def __init__(self, thread_id: str, score: float, text_preview: str = ""):
        self.thread_id = thread_id
        self.score = score
        self.text_preview = text_preview


class ThreadSearchService:
    """
    Singleton service for thread semantic search using Supabase pgvector.

    Handles embedding creation and similarity search for threads.
    """

    _instance: Optional["ThreadSearchService"] = None
    _initialized: bool = False

    # Configuration
    EMBEDDING_MODEL = "text-embedding-3-small"
    EMBEDDING_DIMENSION = 1536

    def __new__(cls) -> "ThreadSearchService":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if self._initialized:
            return

        self._openai_client = None
        self._is_configured = False

        # Check if OpenAI API key is available
        self._openai_api_key = os.getenv("OPENAI_API_KEY")

        if self._openai_api_key:
            self._is_configured = True
            logger.info("[ThreadSearch] Service configured with OpenAI + Supabase pgvector")
        else:
            logger.warning("[ThreadSearch] Service not configured. Missing: OPENAI_API_KEY")

        self._initialized = True

    @property
    def is_configured(self) -> bool:
        """Check if the service is properly configured."""
        return self._is_configured

    def _get_openai_client(self):
        """Lazily initialize OpenAI client."""
        if self._openai_client is None and self._is_configured:
            try:
                from openai import OpenAI
                self._openai_client = OpenAI(api_key=self._openai_api_key)
                logger.debug("[ThreadSearch] OpenAI client initialized")
            except Exception as e:
                logger.error(f"[ThreadSearch] Failed to initialize OpenAI client: {e}")
                self._openai_client = None
        return self._openai_client

    def _create_embedding(self, text: str) -> Optional[List[float]]:
        """Create an embedding vector for the given text."""
        openai = self._get_openai_client()
        if not openai:
            return None

        try:
            # Truncate text if too long (OpenAI has token limits)
            max_chars = 30000
            if len(text) > max_chars:
                text = text[:max_chars]

            response = openai.embeddings.create(
                input=text,
                model=self.EMBEDDING_MODEL
            )
            return response.data[0].embedding
        except Exception as e:
            logger.error(f"[ThreadSearch] Failed to create embedding: {e}")
            return None

    def _extract_snippet(self, text: str, query: str, snippet_length: int = 120) -> Tuple[str, List[str]]:
        """
        Extract a snippet from text centered around matching keywords.
        Prioritizes areas with the most keyword matches.

        Returns:
            Tuple of (snippet with "..." if truncated, list of matched keywords)
        """
        if not text or not query:
            snippet = text[:snippet_length] if text else ""
            return (snippet + "..." if text and len(text) > snippet_length else snippet, [])

        text_lower = text.lower()
        query_words = [w for w in query.lower().split() if len(w) > 2]

        if not query_words:
            snippet = text[:snippet_length]
            return (snippet + "..." if len(text) > snippet_length else snippet, [])

        # Find all positions of each keyword
        keyword_positions = []
        matched_keywords = []
        for word in query_words:
            pos = 0
            while True:
                pos = text_lower.find(word, pos)
                if pos == -1:
                    break
                keyword_positions.append((pos, word))
                if word not in matched_keywords:
                    matched_keywords.append(word)
                pos += 1

        # If no matches, return start of text
        if not keyword_positions:
            snippet = text[:snippet_length]
            return (snippet + "..." if len(text) > snippet_length else snippet, [])

        # Sort by position
        keyword_positions.sort(key=lambda x: x[0])

        # Find the best window - one with most keyword matches
        best_count = 0
        best_pos = keyword_positions[0][0]

        for pos, _ in keyword_positions:
            window_start = max(0, pos - 20)
            window_end = window_start + snippet_length
            count = sum(1 for p, _ in keyword_positions if window_start <= p < window_end)
            if count > best_count:
                best_count = count
                best_pos = pos

        # Calculate window centered on best position
        half_len = snippet_length // 2
        start = max(0, best_pos - half_len)
        end = min(len(text), start + snippet_length)

        # Adjust to not cut words
        if start > 0:
            space_pos = text.find(' ', start)
            if space_pos != -1 and space_pos < start + 20:
                start = space_pos + 1

        if end < len(text):
            space_pos = text.rfind(' ', start, end)
            if space_pos != -1 and space_pos > end - 20:
                end = space_pos

        snippet = text[start:end].strip()

        # Add ellipsis
        prefix = "..." if start > 0 else ""
        suffix = "..." if end < len(text) else ""

        return (f"{prefix}{snippet}{suffix}", matched_keywords)

    async def embed_thread(
        self,
        thread_id: str,
        account_id: str,
        content: str,
        project_name: str = "",
        thread_name: str = ""
    ) -> bool:
        """
        Create or update embeddings for a thread in Supabase.
        Uses recursive character splitting to create multiple chunks.

        Args:
            thread_id: The thread's unique identifier
            account_id: The account that owns the thread
            content: The text content to embed (full conversation)
            project_name: Name of the project (for context)
            thread_name: Name of the thread (for context)

        Returns:
            True if at least one embedding was created successfully, False otherwise
        """
        if not self._is_configured:
            logger.debug("[ThreadSearch] Service not configured, skipping embedding")
            return False

        # Build header with project/thread context
        header = ""
        if project_name:
            header = f"Project: {project_name}"
        if thread_name and thread_name != project_name:
            header += f" | Thread: {thread_name}" if header else f"Thread: {thread_name}"

        if header and content:
            text_to_embed = f"{header}\n\n{content}"
        elif content:
            text_to_embed = content
        else:
            text_to_embed = header or ""

        if not text_to_embed.strip():
            logger.warning(f"[ThreadSearch] No content to embed for thread {thread_id}")
            return False

        # Split into chunks using recursive splitter
        chunks = text_splitter.split_text(text_to_embed)
        logger.info(f"[ThreadSearch] Embedding thread {thread_id}: {len(chunks)} chunks")

        try:
            from core.services.db import execute_mutate

            # Delete existing chunks for this thread first
            await execute_mutate(
                "DELETE FROM public.documents WHERE thread_id = :thread_id",
                {"thread_id": thread_id}
            )

            # Insert each chunk
            success_count = 0
            for chunk_content in chunks:
                embedding = self._create_embedding(chunk_content)
                if not embedding:
                    continue

                embedding_str = json.dumps(embedding)
                sql = """
                INSERT INTO public.documents (chunk_id, thread_id, user_id, chunk_content, embedding, last_updated_at)
                VALUES (:chunk_id, :thread_id, :user_id, :chunk_content, CAST(:embedding AS vector), NOW())
                """

                await execute_mutate(sql, {
                    "chunk_id": str(uuid.uuid4()),
                    "thread_id": thread_id,
                    "user_id": account_id,
                    "chunk_content": chunk_content[:1200],
                    "embedding": embedding_str,
                })
                success_count += 1

            logger.info(f"[ThreadSearch] Embedded {success_count}/{len(chunks)} chunks for thread {thread_id}")
            return success_count > 0

        except Exception as e:
            logger.error(f"[ThreadSearch] Embedding FAILED for thread {thread_id}: {e}")
            return False

    async def search(
        self,
        query: str,
        account_id: str,
        limit: int = 10
    ) -> List[SearchResult]:
        """
        Search for threads semantically matching the query using pgvector.

        Args:
            query: The search query text
            account_id: Filter results to this account only (not used currently)
            limit: Maximum number of results to return

        Returns:
            List of SearchResult objects with thread_id and relevance score
        """
        if not self._is_configured:
            logger.debug("[ThreadSearch] Service not configured, returning empty results")
            return []

        if not query or not query.strip():
            return []

        logger.info(f"[ThreadSearch] Searching: \"{query}\"")

        # Create embedding for the query
        query_embedding = self._create_embedding(query)
        if not query_embedding:
            logger.error(f"[ThreadSearch] OpenAI embedding failed for query: \"{query}\"")
            return []

        try:
            from core.services.db import execute

            # Use pgvector cosine similarity search
            # 1 - (embedding <=> query_embedding) converts distance to similarity score
            # Use CAST instead of :: to avoid parameter parsing issues
            sql = """
            SELECT
                thread_id,
                user_id,
                chunk_content,
                1 - (embedding <=> CAST(:query_embedding AS vector)) as similarity
            FROM public.documents
            WHERE embedding IS NOT NULL
              AND thread_id IS NOT NULL
            ORDER BY embedding <=> CAST(:query_embedding AS vector)
            LIMIT :limit
            """

            rows = await execute(sql, {
                "query_embedding": json.dumps(query_embedding),
                "limit": limit,
            })

            # Convert to SearchResult objects with extracted snippets
            results = []
            for row in rows:
                thread_id = row.get("thread_id")
                if thread_id:
                    # Convert UUID to string if needed
                    thread_id = str(thread_id)
                    full_text = row.get("chunk_content", "")
                    similarity = row.get("similarity", 0)
                    snippet, matched = self._extract_snippet(full_text, query)

                    results.append(SearchResult(
                        thread_id=thread_id,
                        score=float(similarity) if similarity else 0.0,
                        text_preview=snippet
                    ))

                    if matched:
                        logger.debug(f"[ThreadSearch] Thread {thread_id[:8]}... matched: {matched}")

            # Log results
            if results:
                top = results[0]
                logger.info(f"[ThreadSearch] Supabase OK: {len(results)} results, top={top.score:.3f}, preview=\"{top.text_preview[:80]}\"")
            else:
                logger.info(f"[ThreadSearch] Supabase OK: 0 results")

            return results

        except Exception as e:
            logger.error(f"[ThreadSearch] Supabase search FAILED: {e}")
            return []

    async def delete_thread_embedding(self, thread_id: str) -> bool:
        """
        Delete the embedding for a thread.

        Args:
            thread_id: The thread's unique identifier

        Returns:
            True if deletion was successful or embedding didn't exist, False on error
        """
        if not self._is_configured:
            return True

        try:
            from core.services.db import execute_mutate

            sql = "DELETE FROM public.documents WHERE thread_id = :thread_id"
            await execute_mutate(sql, {"thread_id": thread_id})

            logger.info(f"[ThreadSearch] Deleted embedding for thread {thread_id}")
            return True

        except Exception as e:
            logger.error(f"[ThreadSearch] Failed to delete embedding for thread {thread_id}: {e}")
            return False


# Global singleton instance
_thread_search_service: Optional[ThreadSearchService] = None


def get_thread_search_service() -> ThreadSearchService:
    """Get the singleton ThreadSearchService instance."""
    global _thread_search_service
    if _thread_search_service is None:
        _thread_search_service = ThreadSearchService()
    return _thread_search_service


# Convenience functions for simpler usage

async def embed_thread(
    thread_id: str,
    account_id: str,
    content: str,
    project_name: str = "",
    thread_name: str = ""
) -> bool:
    """Embed a thread for semantic search."""
    service = get_thread_search_service()
    return await service.embed_thread(thread_id, account_id, content, project_name, thread_name)


async def search_threads(
    query: str,
    account_id: str,
    limit: int = 10
) -> List[SearchResult]:
    """Search threads semantically."""
    service = get_thread_search_service()
    return await service.search(query, account_id, limit)


async def delete_thread_embedding(thread_id: str) -> bool:
    """Delete embedding for a thread."""
    service = get_thread_search_service()
    return await service.delete_thread_embedding(thread_id)
