from backend.celery_app import celery_app
from utils.logger import logger # Assuming your logger is accessible here
# We will need to import more things here later, like DBConnection, 
# parts of agent/api.py logic, update_agent_run_status, etc.
import time
import asyncio
import json
from typing import Optional, Dict, Any
import traceback
from datetime import datetime, timezone

# Imports from Suna RAG/Agent codebase
from services.supabase import DBConnection, get_supabase_client, SupabaseClient # For type hinting if needed, actual client via run_utils
from services import redis as redis_service # For direct use if any, actual init via run_utils
from agentpress.thread_manager import ThreadManager
from agent.run import run_agent # This is the core agent execution logic
# Import the utility functions we moved
from agent.run_utils import (
    update_agent_run_status,
    stop_agent_run,
    _cleanup_redis_instance_key,
    _cleanup_redis_response_list, # Though stop_agent_run calls this
    get_db_connection, # UPDATED
    ensure_redis_initialized,
    worker_init_services, # For connecting to Celery signals
    worker_shutdown_services, # For connecting to Celery signals
    REDIS_RESPONSE_LIST_TTL # Import constant
)
from utils.config import config # For default model name
from sandbox.sandbox import Sandbox # Added for type hint, actual object comes from params
from celery.signals import worker_process_init, worker_process_shutdown
from litellm import embedding  # For generating embeddings
import pypdf
import docx
import io
import tiktoken # For token counting / advanced chunking if needed

# Semantic Chunking imports
import nltk
from sentence_transformers import SentenceTransformer, util

# Specific error imports
from litellm import exceptions as litellm_exceptions
from pypdf import errors as pypdf_errors

# Connect Celery signals for worker process init and shutdown
@worker_process_init.connect
def init_worker_services(**kwargs):
    logger.info("Worker process init: Initializing services via Celery signal.")
    asyncio.run(worker_init_services())

@worker_process_shutdown.connect
def shutdown_worker_services(**kwargs):
    logger.info("Worker process shutdown: Shutting down services via Celery signal.")
    asyncio.run(worker_shutdown_services())

@celery_app.task(bind=True, acks_late=True, reject_on_worker_lost=True, default_retry_delay=5*60, max_retries=3)
async def execute_agent_processing(self,
                                 agent_run_id: str,
                                 project_id: str, # ADDED
                                 thread_id: str,
                                 model_name: str,
                                 enable_thinking: bool,
                                 reasoning_effort: str,
                                 stream: bool, # This task's stream param - how it affects run_agent call needs care
                                 enable_context_manager: bool,
                                 user_id: str,
                                 instance_id: str,
                                 initial_prompt_message: Optional[Dict[str, Any]] = None
                                 ):
    """
    Celery task to encapsulate the agent processing logic, adapted from agent.api.run_agent_background.
    acks_late=True means the task message will be acknowledged after the task has been executed, not just before.
    reject_on_worker_lost=True will cause the task to be re-queued if the worker process executing it crashes.
    """
    logger.info(f"[Task {self.request.id}] EXECUTE_AGENT_PROCESSING for agent_run_id: {agent_run_id}, project_id: {project_id}, thread_id: {thread_id}")

    db_connection = await get_db_connection() # Use the new function to get DBConnection object
    db_client = await db_connection.client # Get client if needed for direct use, e.g. update_agent_run_status

    active_run_key = f"active_run:{instance_id}:{agent_run_id}"
    control_channel_instance = f"agent_run:{agent_run_id}:control:{instance_id}"
    control_channel_global = f"agent_run:{agent_run_id}:control"
    stop_event = asyncio.Event()

    tm = ThreadManager(db_connection_override=db_connection) # Pass DBConnection object

    # Handle initial_prompt_message by adding it to the thread
    if initial_prompt_message:
        try:
            msg_role = initial_prompt_message.get('role', 'user')
            msg_content = initial_prompt_message.get('content')
            if msg_content: # Ensure there is content
                logger.info(f"[Task {self.request.id}] Adding initial prompt message to thread {thread_id} for agent_run {agent_run_id}")
                await tm.add_message(
                    thread_id=thread_id,
                    type=msg_role,
                    content=msg_content,
                    is_llm_message=(msg_role == 'assistant') # Or determine based on actual role
                )
            else:
                logger.warning(f"[Task {self.request.id}] Initial prompt message for {agent_run_id} lacked content.")
        except Exception as e:
            logger.error(f"[Task {self.request.id}] Failed to add initial prompt message for {agent_run_id}: {e}", exc_info=True)
            # Decide if this is a fatal error for the task
            await update_agent_run_status(agent_run_id, status="failed", error=f"Failed to process initial message: {str(e)}", db_client_override=db_client)
            return {"status": "failed", "agent_run_id": agent_run_id, "error": "Failed to process initial message"}


    async def check_for_stop_signal():
        pubsub = None
        try:
            # Ensure redis is up for this new connection (already handled by worker_init_services)
            # await ensure_redis_initialized() 
            redis_cli = await redis_service.get_async_client() # Get a client instance
            pubsub = redis_cli.pubsub()
            await pubsub.subscribe(control_channel_instance, control_channel_global)
            logger.info(f"[Task {self.request.id}] Subscribed to {control_channel_instance} and {control_channel_global} for stop signals.")
            while not stop_event.is_set():
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.1)
                if message and message["type"] == "message":
                    if message["data"].decode('utf-8') == "STOP":
                        logger.info(f"[Task {self.request.id}] STOP signal received for {agent_run_id} on {message['channel'].decode('utf-8')}. Setting stop_event.")
                        stop_event.set()
                        break
                await asyncio.sleep(0.1) 
        except asyncio.CancelledError:
            logger.info(f"[Task {self.request.id}] Stop signal listener cancelled for {agent_run_id}.")
        except Exception as e:
            logger.error(f"[Task {self.request.id}] Error in stop signal listener for {agent_run_id}: {e}", exc_info=True)
        finally:
            if pubsub:
                try:
                    await pubsub.unsubscribe(control_channel_instance, control_channel_global)
                    # Safely close pubsub if it's a real connection object, redis-py's pubsub objects are typically closed with the connection
                    # If redis_cli is the main connection, it's managed by worker_shutdown_services.
                    # If pubsub has its own close method distinct from the connection: await pubsub.close()
                    logger.debug(f"[Task {self.request.id}] Unsubscribed from pubsub for stop signal listener.")
                except Exception as e:
                    logger.error(f"[Task {self.request.id}] Error cleaning up pubsub for stop signal: {e}", exc_info=True)
            logger.info(f"[Task {self.request.id}] Stop signal listener for {agent_run_id} terminated.")

    stop_signal_task = asyncio.create_task(check_for_stop_signal())
    current_status = "running" 

    try:
        logger.info(f"[Task {self.request.id}] Setting active_run key in Redis: {active_run_key}")
        redis_cli = await redis_service.get_async_client()
        await redis_cli.set(active_run_key, json.dumps({"status": "running", "started_at": datetime.now(timezone.utc).isoformat()}), ex=REDIS_RESPONSE_LIST_TTL)

        final_assistant_messages = [] # Renamed to clarify content
        response_list_key = f"agent_run:{agent_run_id}:responses" # For assistant messages primarily

        async for item in run_agent(
            thread_id=thread_id,
            project_id=project_id,
            stream=False, # Force stream=False for run_agent's internal LLM calls to get whole messages per turn
            thread_manager=tm,
            model_name=model_name or config.MODEL_TO_USE,
            enable_thinking=enable_thinking,
            reasoning_effort=reasoning_effort,
            enable_context_manager=enable_context_manager
        ):
            if isinstance(item, dict):
                item_type = item.get('type')

                if item_type == 'assistant':
                    # This is a direct assistant message object yielded by ResponseProcessor
                    message_obj = item
                    if message_obj.get('role') == 'assistant': # Confirming role
                        final_assistant_messages.append(message_obj)
                        try:
                            await redis_cli.rpush(response_list_key, json.dumps(message_obj))
                            await redis_cli.expire(response_list_key, REDIS_RESPONSE_LIST_TTL)
                            logger.debug(f"[Task {self.request.id}] Appended assistant message to Redis list {response_list_key}")
                        except Exception as e_redis:
                            logger.error(f"[Task {self.request.id}] Failed to push assistant message to Redis list {response_list_key}: {e_redis}", exc_info=True)
                    else:
                        logger.warning(f"[Task {self.request.id}] Received item with type 'assistant' but unexpected role: {message_obj.get('role')}")
                
                elif item_type == 'status':
                    content = item.get('content', {})
                    status_type = content.get('status_type')
                    logger.info(f"[Task {self.request.id}] Agent run {agent_run_id} event: {status_type} - Details: {content}")
                    if status_type == 'tool_error':
                        # Logged for diagnostics, error will be in agent_runs.error if it leads to overall failure
                        logger.error(f"[Task {self.request.id}] Tool error during agent run {agent_run_id}: {content.get('error_details')}")
                    elif status_type == 'thread_run_failed':
                        logger.error(f"[Task {self.request.id}] Agent run {agent_run_id} reported as failed by ResponseProcessor: {content.get('error')}")
                        # This might be an early signal to fail the task

                # Tool messages are saved to the DB by ResponseProcessor but not yielded directly as message objects in non-streaming mode.
                # They are recorded in the 'messages' table. The 'agent_runs.responses' field typically stores assistant outputs.
                # Thus, we are not explicitly collecting 'tool' role messages here for final_assistant_messages.

                elif isinstance(item, dict) and item.get('type') == 'content' and "Agent reached maximum auto-continue limit" in str(item.get('content')):
                    logger.warning(f"[Task {self.request.id}] Agent reached max auto-continue limit for run {agent_run_id}.")
                # else:
                    # logger.debug(f"[Task {self.request.id}] Agent for run {agent_run_id} yielded unhandled item type '{item_type}': {item}")
            else:
                logger.warning(f"[Task {self.request.id}] Agent for run {agent_run_id} yielded non-dict item: {item}")

        if stop_event.is_set():
            logger.info(f"[Task {self.request.id}] Agent run {agent_run_id} was stopped by signal.")
            current_status = "stopped"
            await update_agent_run_status(agent_run_id, status=current_status, error="Manually stopped by user/system.", responses=final_assistant_messages, db_client_override=db_client)
        else:
            logger.info(f"[Task {self.request.id}] Agent run {agent_run_id} completed normally.")
            current_status = "completed"
            await update_agent_run_status(agent_run_id, status=current_status, responses=final_assistant_messages, db_client_override=db_client)

        return {"status": current_status, "agent_run_id": agent_run_id, "final_responses_summary": final_assistant_messages[:3] if final_assistant_messages else None}

    except asyncio.CancelledError:
        logger.warning(f"[Task {self.request.id}] Agent run {agent_run_id} was cancelled.")
        current_status = "failed" 
        try:
            await update_agent_run_status(agent_run_id, status=current_status, error="Task cancelled (worker lost or revoked)", db_client_override=db_client)
        except Exception as db_e:
            logger.error(f"[Task {self.request.id}] Failed to update DB status for cancelled task {agent_run_id}: {db_e}")
        raise 
    except Exception as e:
        logger.error(f"[Task {self.request.id}] Exception in agent run {agent_run_id}: {str(e)}\n{traceback.format_exc()}")
        current_status = "failed"
        try:
            await update_agent_run_status(agent_run_id, status=current_status, error=str(e), db_client_override=db_client)
        except Exception as db_e:
            logger.error(f"[Task {self.request.id}] Failed to update DB status for failed task {agent_run_id}: {db_e}")
        raise 
    finally:
        logger.info(f"[Task {self.request.id}] Cleaning up for agent_run {agent_run_id}, final status: {current_status}")
        stop_event.set() 
        if stop_signal_task:
            try:
                await asyncio.wait_for(stop_signal_task, timeout=5.0) 
            except asyncio.TimeoutError:
                logger.warning(f"[Task {self.request.id}] Timeout waiting for stop_signal_task to finish for {agent_run_id}.")
                stop_signal_task.cancel() 
            except Exception as e_stop_task:
                logger.error(f"[Task {self.request.id}] Exception during stop_signal_task cleanup: {e_stop_task}")

        await _cleanup_redis_instance_key(agent_run_id, instance_id)

        if current_status not in ["completed"]:
             logger.info(f"[Task {self.request.id}] Run did not complete successfully ({current_status}), calling stop_agent_run for full cleanup for {agent_run_id}.")
             await stop_agent_run(agent_run_id, 
                                  error_message=f"Run ended with status: {current_status}", 
                                  instance_id_for_cleanup=instance_id)
        else:
            await _cleanup_redis_response_list(agent_run_id)
            
        logger.info(f"[Task {self.request.id}] Finished execute_agent_processing for {agent_run_id}")

# Constants for chunking (can be refined)
# These values are just examples, you might need to adjust them.
# Based on OpenAI's ada-002 context window (8191 tokens) and typical chunk sizes for RAG.
# A chunk size of 512-1024 tokens is often a good starting point.
# We'll use character count for simplicity first, then can move to token-based.
# AVG Token length is ~4 chars. So 512 tokens ~ 2048 chars.
# CHUNK_SIZE_CHARS = 2000  # Commented out as it's no longer used by semantic chunking
# CHUNK_OVERLAP_CHARS = 200 # Commented out as it's no longer used by semantic chunking

# --- New constants for Semantic Chunking ---
# Threshold for cosine similarity: if similarity between sentence N and N+1 is BELOW this, it's a potential break.
SEMANTIC_SIMILARITY_BREAK_THRESHOLD = 0.45 # Adjusted based on typical E5 behavior (lower means more breaks)
# Max tokens for a chunk (using cl100k_base for estimation, similar to ada-002 and other LLMs)
MAX_CHUNK_TOKENS = 500
# Min tokens for a chunk to avoid very small, possibly noisy chunks from too many semantic breaks.
MIN_CHUNK_TOKENS = 50
# --- End New constants ---

# Initialize tokenizer for token counting
try:
    tokenizer = tiktoken.get_encoding("cl100k_base")
except Exception as e:
    logger.error(f"Failed to load tiktoken tokenizer: {e}. Falling back to GPT-2 tokenizer.")
    tokenizer = tiktoken.get_encoding("gpt2") # Fallback

# Initialize Sentence Transformer Model and NLTK sentence tokenizer
# This will be loaded once per worker process when the module is imported.
SENTENCE_MODEL_NAME = "intfloat/multilingual-e5-large"
try:
    logger.info(f"Attempting to download NLTK 'punkt' model if not present...")
    try:
        nltk.data.find('tokenizers/punkt')
    except nltk.downloader.DownloadError:
        nltk.download('punkt', quiet=True)
    logger.info(f"NLTK 'punkt' model should be available.")
    
    logger.info(f"Loading sentence transformer model: {SENTENCE_MODEL_NAME}...")
    sentence_model = SentenceTransformer(SENTENCE_MODEL_NAME)
    logger.info(f"Sentence transformer model {SENTENCE_MODEL_NAME} loaded successfully.")
except Exception as e:
    logger.error(f"CRITICAL: Failed to load sentence_transformer model ({SENTENCE_MODEL_NAME}) or NLTK 'punkt': {e}", exc_info=True)
    # If the model can't load, semantic chunking won't work. 
    # We might want a fallback or to prevent tasks from running. For now, log critical error.
    sentence_model = None 

# Helper function to update document status in the database
async def _update_kb_document_status(db: SupabaseClient, document_id: str, status: str, error_message: str = None):
    try:
        update_data = {"status": status, "updated_at": datetime.now(timezone.utc).isoformat()}
        if error_message:
            update_data["error_message"] = error_message
        
        await db.table("knowledge_base_documents").update(update_data).eq("id", document_id).execute()
        logger.info(f"Updated KB document {document_id} status to {status}")
    except Exception as e:
        logger.error(f"Failed to update KB document {document_id} status to {status}: {e}")

# Helper function for basic character-based chunking (Now Deprecated)
# def chunk_text_by_char(text: str, chunk_size: int, chunk_overlap: int) -> list[str]:
#     chunks = []
#     start_index = 0
#     text_len = len(text)
#     while start_index < text_len:
#         end_index = min(start_index + chunk_size, text_len)
#         chunks.append(text[start_index:end_index])
#         start_index += chunk_size - chunk_overlap
#         if start_index >= end_index and start_index < text_len: # Ensure progress if overlap is large or chunk is small
#             start_index = end_index 
#     return chunks

# --- New Semantic Chunking Function ---
def chunk_text_semantically(text: str) -> list[str]:
    if not sentence_model:
        logger.error("Sentence model not loaded. Cannot perform semantic chunking. Falling back to basic text splitting (not implemented yet as fallback here).")
        # As a very basic fallback if model loading failed, split by paragraphs or a large fixed token count.
        # For now, returning the whole text as one chunk if model is missing (can be very large).
        # A proper fallback to character-based or simple token split should be implemented if this is a concern.
        # This will likely cause issues downstream if the text is large.
        return [text] if text.strip() else []

    if not text or not text.strip():
        logger.info("Input text is empty or whitespace only. Returning no chunks.")
        return []

    try:
        sentences = nltk.sent_tokenize(text)
    except Exception as e:
        logger.error(f"NLTK sent_tokenize failed: {e}. Returning text as a single chunk.", exc_info=True)
        return [text] # Fallback if sentence tokenization fails

    if not sentences:
        logger.info("No sentences found after tokenization. Returning no chunks.")
        return []
    
    logger.debug(f"Original text split into {len(sentences)} sentences.")

    # Handle very short texts or texts with few sentences
    if len(sentences) <= 1:
        # If only one sentence (or zero after filter), check its token count
        single_chunk_text = " ".join(sentences).strip()
        if not single_chunk_text: return []
        
        tokens = tokenizer.encode(single_chunk_text)
        if len(tokens) > MAX_CHUNK_TOKENS:
            logger.warning(f"Single sentence text is too long ({len(tokens)} tokens > {MAX_CHUNK_TOKENS}). Truncating or splitting further might be needed. For now, returning as one chunk.")
            # TODO: Implement splitting for single long sentences if this becomes an issue.
            # For now, we'll return it as is, but it might exceed embedding model limits.
        return [single_chunk_text]

    try:
        # Encode all sentences. Device management is handled by SentenceTransformer.
        sentence_embeddings = sentence_model.encode(sentences, show_progress_bar=False)
    except Exception as e:
        logger.error(f"Failed to encode sentences with SentenceTransformer: {e}. Returning text as a single chunk.", exc_info=True)
        return [text]


    chunks = []
    current_chunk_sentences_list = []
    current_token_count = 0

    for i in range(len(sentences)):
        sentence_text = sentences[i].strip()
        if not sentence_text:
            continue

        sentence_tokens = len(tokenizer.encode(sentence_text))
        
        # If current chunk is empty, always add the first sentence
        if not current_chunk_sentences_list:
            current_chunk_sentences_list.append(sentence_text)
            current_token_count = sentence_tokens
            continue

        # Calculate similarity with the *last added sentence* in the current chunk
        # This is slightly different from only adjacent: it checks if the new sentence fits the current forming chunk.
        # For simplicity and to match common patterns, let's stick to similarity with the direct previous sentence (sentences[i-1])
        # The sentence_embeddings correspond to the original sentences list.
        # The 'previous' sentence in the context of forming a chunk is the one at sentences[i-1]
        # if it was part of the current_chunk_sentences_list.
        # More directly: check similarity between sentences[i-1] and sentences[i]
        
        similarity_to_previous = util.cos_sim(sentence_embeddings[i-1], sentence_embeddings[i]).item()
        logger.debug(f"Similarity between \"{sentences[i-1][:50]}...\" and \"{sentences[i][:50]}...\" : {similarity_to_previous:.4f}")
        
        # Conditions to finalize the current chunk and start a new one:
        # 1. Semantic break: Similarity drops AND current chunk has reached a minimum sensible size.
        new_chunk_due_to_semantic_break = (similarity_to_previous < SEMANTIC_SIMILARITY_BREAK_THRESHOLD and 
                                           current_token_count >= MIN_CHUNK_TOKENS)
        
        # 2. Max token limit: Adding the current sentence would make the chunk too large.
        new_chunk_due_to_token_limit = (current_token_count + sentence_tokens) > MAX_CHUNK_TOKENS
        
        if new_chunk_due_to_semantic_break or new_chunk_due_to_token_limit:
            if current_chunk_sentences_list: # Ensure there's something to add
                chunks.append(" ".join(current_chunk_sentences_list))
                logger.debug(f"Created chunk (len: {current_token_count} tokens) due to: {'semantic break' if new_chunk_due_to_semantic_break else 'token limit'}")
            
            current_chunk_sentences_list = [sentence_text]
            current_token_count = sentence_tokens
        else:
            # Add current sentence to the ongoing chunk
            current_chunk_sentences_list.append(sentence_text)
            current_token_count += sentence_tokens

    # Add the last remaining chunk
    if current_chunk_sentences_list:
        chunks.append(" ".join(current_chunk_sentences_list))
        logger.debug(f"Created final chunk (len: {current_token_count} tokens)")

    # Filter out any empty chunks that might have been formed
    final_chunks = [chunk for chunk in chunks if chunk.strip()]
    logger.info(f"Semantic chunking produced {len(final_chunks)} chunks.")
    return final_chunks
# --- End Semantic Chunking Function ---

# Define the actual Celery task
# The name should match what's used in kb/api.py: process_kb_document_task.delay(...)
# If celery_app.py includes 'agent.tasks', this will be discoverable.
@celery_app.task(name='agent.tasks.process_kb_document_task', bind=True, acks_late=True, reject_on_worker_lost=True, default_retry_delay=5*60, max_retries=3)
async def process_kb_document_task(self, document_id: str):
    """
    Celery task to process a document for the Knowledge Base:
    1. Fetch document metadata.
    2. Download file from Supabase Storage.
    3. Extract text content.
    4. Chunk text.
    5. Generate embeddings for chunks.
    6. Store chunks and embeddings in the database.
    7. Update document status.
    """
    logger.info(f"[KB Task {self.request.id}] Starting processing for document_id: {document_id}")
    
    # It's generally better to create a new Supabase client per task or ensure thread-safety
    # if using a global client. For simplicity, re-creating or getting a fresh one.
    # This assumes get_supabase_client() can be called outside an HTTP request context,
    # or you have another way to initialize a Supabase client for background tasks.
    # If get_supabase_client relies on FastAPI Depends, we need a different way.
    # For now, let's assume a direct way to get a client, or adapt DBConnection.

    # Initialize services if needed (e.g., Supabase client)
    # Similar to worker_init_services but might be simpler if only Supabase is needed.
    db_connection = await get_db_connection() # From agent.run_utils or a similar utility
    db = await db_connection.client

    try:
        # 1. Fetch document metadata
        doc_query = await db.table("knowledge_base_documents").select("*").eq("id", document_id).maybe_single().execute()
        doc_info = doc_query.data

        if not doc_info:
            logger.error(f"[KB Task {self.request.id}] Document {document_id} not found. Aborting.")
            # No need to update status if doc doesn't exist, or could mark as 'error' if this is unexpected.
            return

        await _update_kb_document_status(db, document_id, "processing")
        
        file_name = doc_info.get("file_name")
        storage_path = doc_info.get("storage_path")
        mime_type = doc_info.get("mime_type")
        project_id = doc_info.get("project_id")
        bucket_name = "project_knowledge_bases" # As defined in kb/api.py

        logger.info(f"[KB Task {self.request.id}] Processing: {file_name} (type: {mime_type}) from storage path: {storage_path}")

        # 2. Download file from Supabase Storage
        file_content_bytes = None
        try:
            download_response = await asyncio.to_thread(db.storage.from_(bucket_name).download, storage_path)
            # download_response = db.storage.from_(bucket_name).download(storage_path) # Older sync version
            if not download_response:
                raise Exception("Downloaded content is empty or download failed.")
            file_content_bytes = download_response # This is already bytes
            logger.info(f"[KB Task {self.request.id}] Successfully downloaded {file_name} from storage.")
        except Exception as e_download:
            logger.error(f"[KB Task {self.request.id}] Failed to download {file_name} from {storage_path}: {e_download}")
            try:
                # Retry for generic download issues, which might be transient network problems.
                logger.info(f"[KB Task {self.request.id}] Retrying document download for {document_id} due to: {e_download}. Attempt {self.request.retries + 1} of {self.max_retries}")
                raise self.retry(exc=e_download, countdown=int(self.default_retry_delay * (self.request.retries + 1))) # Exponential backoff basic
            except self.MaxRetriesExceededError:
                logger.error(f"[KB Task {self.request.id}] Max retries exceeded for downloading {file_name}.")
                await _update_kb_document_status(db, document_id, "failed", f"Failed to download file after multiple retries: {str(e_download)[:200]}")
                return
            except Exception as e_retry_setup: # Catch issues with the retry call itself, though unlikely
                logger.error(f"[KB Task {self.request.id}] Error setting up retry for download: {e_retry_setup}. Failing document.")
                await _update_kb_document_status(db, document_id, "failed", f"Download error (retry mechanism failed): {str(e_download)[:180]}")
                return

        # 3. Extract text content
        extracted_text = ""
        try:
            if mime_type == "application/pdf":
                with io.BytesIO(file_content_bytes) as pdf_file:
                    reader = pypdf.PdfReader(pdf_file)
                    for page in reader.pages:
                        extracted_text += page.extract_text() + "\n"
            elif mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
                with io.BytesIO(file_content_bytes) as docx_file:
                    document = docx.Document(docx_file)
                    for para in document.paragraphs:
                        extracted_text += para.text + "\n"
            elif mime_type in ["text/plain", "text/markdown"]:
                extracted_text = file_content_bytes.decode('utf-8') # Assuming UTF-8 for text files
            else:
                logger.warning(f"[KB Task {self.request.id}] Unsupported MIME type for text extraction: {mime_type} for file {file_name}")
                await _update_kb_document_status(db, document_id, "failed", f"Unsupported file type: {mime_type}")
                return
            logger.info(f"[KB Task {self.request.id}] Successfully extracted text from {file_name} (length: {len(extracted_text)} chars).")
        except pypdf_errors.PdfReadError as e_pdf_read:
            logger.error(f"[KB Task {self.request.id}] Failed to extract text from PDF {file_name} (corrupted or password-protected?): {e_pdf_read}")
            await _update_kb_document_status(db, document_id, "failed", f"PDF processing error: {str(e_pdf_read)[:200]}")
            return
        except Exception as e_extract: # General text extraction errors
            logger.error(f"[KB Task {self.request.id}] Failed to extract text from {file_name}: {e_extract}")
            await _update_kb_document_status(db, document_id, "failed", f"Text extraction failed: {str(e_extract)[:250]}")
            return

        if not extracted_text.strip():
            logger.warning(f"[KB Task {self.request.id}] Extracted text from {file_name} is empty. Marking as indexed (with no content).")
            await _update_kb_document_status(db, document_id, "indexed", "Document contained no extractable text.")
            return

        # 4. Chunk text
        # Using basic character-based chunking for now.
        # TODO: Explore more advanced token-based chunking (e.g., using tiktoken)
        # and semantic chunking for better RAG performance.
        # text_chunks = chunk_text_by_char(extracted_text, CHUNK_SIZE_CHARS, CHUNK_OVERLAP_CHARS)
        
        logger.info(f"[KB Task {self.request.id}] Starting semantic chunking for {file_name} (text length: {len(extracted_text)} chars).")
        if sentence_model is None:
            logger.error(f"[KB Task {self.request.id}] Sentence model not loaded. Semantic chunking cannot proceed for {file_name}. Document processing will fail.")
            await _update_kb_document_status(db, document_id, "failed", "Semantic chunking model unavailable.")
            return

        try:
            text_chunks = chunk_text_semantically(extracted_text)
        except Exception as e_chunk:
            logger.error(f"[KB Task {self.request.id}] Error during semantic chunking for {file_name}: {e_chunk}", exc_info=True)
            await _update_kb_document_status(db, document_id, "failed", f"Semantic chunking failed: {str(e_chunk)[:200]}")
            return
            
        logger.info(f"[KB Task {self.request.id}] Split text into {len(text_chunks)} chunks for {file_name} using semantic chunking.")

        if not text_chunks:
            logger.warning(f"[KB Task {self.request.id}] No text chunks generated for {file_name} despite non-empty text. This might be due to very short text.")
            await _update_kb_document_status(db, document_id, "indexed", "No text chunks generated (text might be too short).")
            return

        # 5. Generate embeddings for chunks and 6. Store chunks and embeddings
        # We will use OpenAI's text-embedding-ada-002 by default via LiteLLM
        # Ensure LiteLLM is configured with an API key (e.g., OPENAI_API_KEY)
        embedding_model = config.EMBEDDING_MODEL_TO_USE # e.g., "text-embedding-ada-002"
        
        # Batch inserts for efficiency if supported well by Supabase client and pgvector
        # For now, sequential insert for simplicity.
        # Supabase Python client batch insert example:
        # response = await db.table('knowledge_base_chunks').insert(chunks_to_insert).execute()

        # Before inserting new chunks, it might be wise to delete any existing chunks for this document_id
        # if this task can be re-run or if documents can be updated.
        try:
            await db.table("knowledge_base_chunks").delete().eq("document_id", document_id).execute()
            logger.info(f"[KB Task {self.request.id}] Deleted existing chunks for document {document_id} before re-indexing.")
        except Exception as e_delete_chunks:
            logger.error(f"[KB Task {self.request.id}] Failed to delete existing chunks for document {document_id}: {e_delete_chunks}")
            # Decide if this is a fatal error. For re-indexing, it might be.
            await _update_kb_document_status(db, document_id, "failed", f"Failed to clear old chunks: {str(e_delete_chunks)[:200]}")
            return

        chunk_num = 0
        for chunk_text in text_chunks:
            chunk_num += 1
            if not chunk_text.strip(): # Skip empty chunks that might result from aggressive splitting
                logger.debug(f"[KB Task {self.request.id}] Skipping empty chunk for document {document_id}, chunk number {chunk_num}")
                continue
            try:
                # Ensure API key is available if using OpenAI, handled by LiteLLM config or env vars
                response = await embedding(model=embedding_model, input=[chunk_text])
                chunk_embedding = response.data[0]["embedding"]
                
                chunk_metadata = {
                    "source_document_id": document_id,
                    "file_name": file_name,
                    "project_id": str(project_id), # Store project_id for potential direct filtering
                    "chunk_number": chunk_num,
                    "original_text_length": len(chunk_text)
                }

                await db.table("knowledge_base_chunks").insert({
                    "document_id": document_id,
                    "chunk_text": chunk_text,
                    "embedding": chunk_embedding,
                    "metadata": chunk_metadata
                }).execute()
                logger.debug(f"[KB Task {self.request.id}] Stored chunk {chunk_num}/{len(text_chunks)} for document {document_id}")

            except (
                litellm_exceptions.APIConnectionError,
                litellm_exceptions.Timeout,
                litellm_exceptions.ServiceUnavailableError,
                litellm_exceptions.RateLimitError,
                litellm_exceptions.APIError # A more generic LiteLLM API error that might be transient
            ) as e_embed_retryable:
                logger.warning(f"[KB Task {self.request.id}] Retryable error generating/storing chunk {chunk_num} for doc {document_id}: {e_embed_retryable}. Retrying task.")
                try:
                    raise self.retry(exc=e_embed_retryable, countdown=int(self.default_retry_delay * (self.request.retries + 1)))
                except self.MaxRetriesExceededError:
                    logger.error(f"[KB Task {self.request.id}] Max retries exceeded for embedding chunk {chunk_num} of doc {document_id} after LiteLLM error: {e_embed_retryable}")
                    await _update_kb_document_status(db, document_id, "failed", f"Embedding failed after retries (chunk {chunk_num}): {str(e_embed_retryable)[:150]}")
                    return
                except Exception as e_retry_setup:
                    logger.error(f"[KB Task {self.request.id}] Error setting up retry for embedding: {e_retry_setup}. Failing document.")
                    await _update_kb_document_status(db, document_id, "failed", f"Embedding error (retry setup failed on chunk {chunk_num}): {str(e_embed_retryable)[:100]}")
                    return
            except (
                litellm_exceptions.AuthenticationError,
                litellm_exceptions.InvalidRequestError,
                litellm_exceptions.NotFoundError, # e.g. model not found
                litellm_exceptions.BadRequestError
            ) as e_embed_fatal_litellm:
                logger.error(f"[KB Task {self.request.id}] Fatal LiteLLM error processing/storing chunk {chunk_num} for doc {document_id}: {e_embed_fatal_litellm}")
                await _update_kb_document_status(db, document_id, "failed", f"Fatal embedding error (chunk {chunk_num}): {str(e_embed_fatal_litellm)[:150]}")
                return
            except Exception as e_embed_store: # Other non-LiteLLM specific errors during embedding/storage (e.g., DB error)
                logger.error(f"[KB Task {self.request.id}] Error processing/storing chunk {chunk_num} for doc {document_id}: {e_embed_store}")
                await _update_kb_document_status(db, document_id, "failed", f"Error on chunk {chunk_num}: {str(e_embed_store)[:200]}")
                return # Stop processing further chunks for this document
        
        logger.info(f"[KB Task {self.request.id}] Successfully processed and stored all {chunk_num} chunks for {file_name}.")

        # 7. Update document status to 'indexed'
        await _update_kb_document_status(db, document_id, "indexed")
        logger.info(f"[KB Task {self.request.id}] Successfully completed processing for document_id: {document_id}")

    except Exception as e:
        logger.error(f"[KB Task {self.request.id}] Unhandled exception processing document {document_id}: {e}", exc_info=True)
        try:
            # Attempt to mark as failed if not already done
            await _update_kb_document_status(db, document_id, "failed", f"Unhandled task error: {str(e)[:250]}")
        except Exception as e_final_status:
            logger.error(f"[KB Task {self.request.id}] Critial: Failed to update final error status for doc {document_id}: {e_final_status}")
    finally:
        # Ensure DB connection is released/closed if it was task-specific
        # REMOVED: await db_connection.disconnect() - This is handled by worker lifecycle signals
        # if db_connection:
        #     await db_connection.disconnect() # Or your equivalent cleanup for the DB client
        logger.debug(f"[KB Task {self.request.id}] Finished processing for document_id: {document_id}. DB connection remains open for worker lifecycle.")

# Make sure this task is imported by Celery worker.
# If celery_app.py has `include=['agent.tasks']`, it should be picked up.
