#!/usr/bin/env python3
"""
One-time script to generate embeddings for all existing threads.
Embeds the ENTIRE thread conversation as chunks.

Usage:
    cd backend
    uv run python scripts/backfill_thread_embeddings.py
"""

import asyncio
import json
import os
import sys
import uuid
from typing import List, Tuple

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv()

# Chunk configuration
CHUNK_SIZE = 1200  # Characters per chunk
CHUNK_OVERLAP = 100  # Overlap between chunks


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
        # Separators in priority order - try to split at these boundaries
        self.separators = separators or [
            "\n\nUser: ",      # Highest priority: user message boundary
            "\n\nAssistant: ", # Assistant message boundary
            "\n\n",            # Paragraph
            "\n",              # Line break
            ". ",              # Sentence
            "? ",
            "! ",
            "; ",
            ", ",
            " ",               # Word
            ""                 # Character (last resort)
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

        # Find the appropriate separator for this text
        separator = separators[-1]  # Default to last (character-level)
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

        # Split by the chosen separator
        if separator:
            splits = text.split(separator)
            # Re-add separator to maintain context (except for the last split)
            splits = [s + separator if i < len(splits) - 1 else s
                     for i, s in enumerate(splits)]
        else:
            splits = list(text)

        # Process splits
        current_chunk = ""

        for split in splits:
            split = split.strip() if not separator else split

            if not split:
                continue

            # If adding this split would exceed chunk_size
            if len(current_chunk) + len(split) > self.chunk_size:
                # Save current chunk if it has content
                if current_chunk.strip():
                    final_chunks.append(current_chunk.strip())

                # If split itself is too large, recursively split it
                if len(split) > self.chunk_size:
                    if new_separators:
                        sub_chunks = self._split_recursive(split, new_separators)
                        final_chunks.extend(sub_chunks)
                        current_chunk = ""
                    else:
                        # Force split at chunk_size
                        for i in range(0, len(split), self.chunk_size - self.chunk_overlap):
                            chunk = split[i:i + self.chunk_size].strip()
                            if chunk:
                                final_chunks.append(chunk)
                        current_chunk = ""
                else:
                    # Start new chunk with overlap from previous
                    if final_chunks and self.chunk_overlap > 0:
                        overlap_text = final_chunks[-1][-self.chunk_overlap:]
                        current_chunk = overlap_text + " " + split
                    else:
                        current_chunk = split
            else:
                current_chunk += split

        # Don't forget the last chunk
        if current_chunk.strip():
            final_chunks.append(current_chunk.strip())

        return [c for c in final_chunks if c]


# Global splitter instance
text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=CHUNK_SIZE,
    chunk_overlap=CHUNK_OVERLAP
)


def chunk_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> List[str]:
    """Split text into overlapping chunks using recursive character splitter."""
    if chunk_size != CHUNK_SIZE or overlap != CHUNK_OVERLAP:
        # Create a custom splitter if non-default params
        splitter = RecursiveCharacterTextSplitter(chunk_size=chunk_size, chunk_overlap=overlap)
        return splitter.split_text(text)
    return text_splitter.split_text(text)


def format_messages(messages: List[dict]) -> str:
    """Format messages into a conversation string."""
    lines = []

    for msg in messages:
        msg_type = msg.get('type', '')
        content = msg.get('content', {})
        text = ''

        # Content is JSONB - could be dict, string, or already parsed
        if isinstance(content, str):
            # Try to parse as JSON if it's a string
            try:
                parsed = json.loads(content)
                if isinstance(parsed, dict):
                    text = parsed.get('content', '') or parsed.get('text', '') or parsed.get('message', '')
                else:
                    text = content
            except (json.JSONDecodeError, TypeError):
                text = content

        # Extract text content from JSONB structure
        elif isinstance(content, dict):
            # Try common content structures
            text = content.get('content', '') or content.get('text', '') or content.get('message', '')
        else:
            text = str(content) if content else ''

        if not text or len(text.strip()) < 3:
            continue

        # Format based on type
        if msg_type == 'user':
            lines.append(f"User: {text}")
        elif msg_type == 'assistant':
            lines.append(f"Assistant: {text}")

    return '\n\n'.join(lines)


async def main():
    from core.services.db import init_db, execute, execute_mutate, close_db
    from core.threads.thread_search import get_thread_search_service

    print("=" * 60)
    print("Thread Embedding Backfill Script (Full Conversation)")
    print("=" * 60)

    # Initialize database
    await init_db()

    service = get_thread_search_service()
    if not service.is_configured:
        print("ERROR: ThreadSearchService not configured. Set OPENAI_API_KEY.")
        await close_db()
        return

    # Configuration
    # Set TEST_USER_ID to a UUID string to filter by user, or None for all users
    # Set TEST_LIMIT to an integer to limit threads, or None for all threads
    TEST_USER_ID = None  # e.g. "41ad6e13-54f6-407c-b56c-803a8b049b86" or None for all
    TEST_LIMIT = None    # e.g. 20 or None for all
    PARALLEL_WORKERS = 10  # Number of parallel embedding tasks (increase for faster processing)

    # Get threads
    print("\nFetching threads...")
    if TEST_USER_ID:
        threads_sql = """
        SELECT
            t.thread_id,
            t.account_id,
            t.name as thread_name,
            p.name as project_name
        FROM threads t
        LEFT JOIN projects p ON t.project_id = p.project_id
        WHERE t.account_id = :account_id
        ORDER BY t.created_at DESC
        LIMIT :limit
        """
        threads = await execute(threads_sql, {"account_id": TEST_USER_ID, "limit": TEST_LIMIT or 10000})
    else:
        threads_sql = """
        SELECT
            t.thread_id,
            t.account_id,
            t.name as thread_name,
            p.name as project_name
        FROM threads t
        LEFT JOIN projects p ON t.project_id = p.project_id
        ORDER BY t.created_at DESC
        """
        threads = await execute(threads_sql, {})
        if TEST_LIMIT:
            threads = threads[:TEST_LIMIT]
    print(f"Found {len(threads)} threads\n")

    if not threads:
        print("Nothing to do!")
        await close_db()
        return

    # Process threads in parallel
    semaphore = asyncio.Semaphore(PARALLEL_WORKERS)
    results = {"success": 0, "failed": 0, "skipped": 0, "chunks": 0}
    results_lock = asyncio.Lock()

    async def process_thread(idx: int, thread: dict):
        async with semaphore:
            thread_id = str(thread['thread_id'])
            account_id = str(thread['account_id']) if thread['account_id'] else ""
            project_name = thread.get('project_name') or ""
            thread_name = thread.get('thread_name') or ""

            # Get all messages for this thread
            messages_sql = """
            SELECT type, content
            FROM messages
            WHERE thread_id = :thread_id
            ORDER BY created_at ASC
            """

            try:
                messages = await execute(messages_sql, {"thread_id": thread_id})
            except Exception as e:
                print(f"[{idx}/{len(threads)}] Thread {thread_id[:8]}... ERROR: {e}")
                async with results_lock:
                    results["failed"] += 1
                return

            if not messages:
                print(f"[{idx}/{len(threads)}] Thread {thread_id[:8]}... SKIP (no messages)")
                async with results_lock:
                    results["skipped"] += 1
                return

            # Format conversation
            conversation = format_messages(messages)

            if not conversation.strip():
                print(f"[{idx}/{len(threads)}] Thread {thread_id[:8]}... SKIP (empty content)")
                async with results_lock:
                    results["skipped"] += 1
                return

            # Add project/thread context
            header = ""
            if project_name:
                header = f"Project: {project_name}"
            if thread_name and thread_name != project_name:
                header += f" | Thread: {thread_name}" if header else f"Thread: {thread_name}"

            if header:
                conversation = f"{header}\n\n{conversation}"

            # Split into chunks
            chunks = chunk_text(conversation)

            # Delete old chunks for this thread
            try:
                await execute_mutate(
                    "DELETE FROM public.documents WHERE thread_id = :thread_id",
                    {"thread_id": thread_id}
                )
            except Exception:
                pass

            # Embed and store each chunk
            chunk_success = 0
            for chunk_idx, chunk_text_content in enumerate(chunks):
                embedding = service._create_embedding(chunk_text_content)
                if not embedding:
                    continue

                try:
                    embedding_str = json.dumps(embedding)
                    sql = """
                    INSERT INTO public.documents (chunk_id, thread_id, user_id, chunk_content, embedding, last_updated_at)
                    VALUES (:chunk_id, :thread_id, :user_id, :chunk_content, CAST(:embedding AS vector), NOW())
                    """

                    await execute_mutate(sql, {
                        "chunk_id": str(uuid.uuid4()),
                        "thread_id": thread_id,
                        "user_id": account_id if account_id else None,
                        "chunk_content": chunk_text_content[:1200],
                        "embedding": embedding_str,
                    })
                    chunk_success += 1
                except Exception as e:
                    print(f"[{idx}/{len(threads)}] Thread {thread_id[:8]}... chunk {chunk_idx} failed: {e}")

            if chunk_success > 0:
                print(f"[{idx}/{len(threads)}] Thread {thread_id[:8]}... OK ({chunk_success}/{len(chunks)} chunks)")
                async with results_lock:
                    results["success"] += 1
                    results["chunks"] += chunk_success
            else:
                print(f"[{idx}/{len(threads)}] Thread {thread_id[:8]}... FAILED")
                async with results_lock:
                    results["failed"] += 1

    # Run all threads in parallel (limited by semaphore)
    print(f"Processing with {PARALLEL_WORKERS} parallel workers...\n")
    tasks = [process_thread(i, thread) for i, thread in enumerate(threads, 1)]
    await asyncio.gather(*tasks)

    success_threads = results["success"]
    failed_threads = results["failed"]
    skipped_threads = results["skipped"]
    total_chunks = results["chunks"]

    # Summary
    print("\n" + "=" * 60)
    print("COMPLETE")
    print(f"  Threads processed: {success_threads}")
    print(f"  Threads failed:    {failed_threads}")
    print(f"  Threads skipped:   {skipped_threads}")
    print(f"  Total chunks:      {total_chunks}")
    print("=" * 60)

    await close_db()


if __name__ == "__main__":
    asyncio.run(main())
