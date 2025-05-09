import json
from typing import List, Dict, Any, Optional
import uuid
from agentpress.tool import ToolResult, openapi_schema, xml_schema
from services.supabase import SupabaseClient, get_supabase_client # Assuming get_supabase_client works here or we adapt
from litellm import embedding
from utils.config import config
from utils.logger import logger

# Specific error imports (if needed for more granular handling in tool)
from litellm import exceptions as litellm_exceptions
from postgrest import APIError as PostgrestAPIError # For Supabase RPC errors

# Reranking import
from sentence_transformers.cross_encoder import CrossEncoder

# Placeholder: Adapt DBConnection/client acquisition for tool context if needed
# Maybe tools should receive a db client/connection factory?
# For now, assuming get_supabase_client can be used somewhat directly or adapted.
# A more robust approach might involve passing DBConnection from ThreadManager.

# Assuming a base class exists or adapting structure from other tools
class KnowledgeRetrievalTool:
    """Tool for retrieving relevant information from the project's Knowledge Base."""

    def __init__(self, project_id: uuid.UUID, db: Optional[SupabaseClient] = None):
        """
        Initializes the tool with the project context.
        Args:
            project_id: The UUID of the current project.
            db: An optional Supabase client instance. If not provided, it will try to get one.
        """
        self.project_id = project_id
        self._db = db
        logger.info(f"KnowledgeRetrievalTool initialized for project {project_id}")

        # --- Initialize Re-ranker Model --- 
        self._reranker_model = None
        reranker_model_name = 'amberoad/bert-multilingual-passage-reranker-msmarco' # Define model name
        try:
            logger.info(f"Loading cross-encoder reranker model: {reranker_model_name}...")
            # Consider adding device='cuda' if GPU is available and configured with torch
            self._reranker_model = CrossEncoder(reranker_model_name)
            logger.info(f"Cross-encoder reranker model {reranker_model_name} loaded successfully.")
        except Exception as e:
            logger.error(f"Failed to load cross-encoder reranker model '{reranker_model_name}': {e}", exc_info=True)
            # Tool will function without reranking if model fails to load.
        # ---------------------------------

    async def _get_db_client(self) -> SupabaseClient:
        """Gets the Supabase client instance provided during initialization."""
        if not self._db:
            # This should not happen if the tool is initialized correctly with a DB client.
            logger.error("KnowledgeRetrievalTool: Supabase client not provided during initialization.")
            raise ValueError("Supabase client not available in KnowledgeRetrievalTool. It must be provided during initialization.")
        return self._db

    def fail_response(self, message: str) -> ToolResult:
        """Helper to create a failed ToolResult."""
        return ToolResult(success=False, content=message)

    def success_response(self, content: Any) -> ToolResult:
        """Helper to create a successful ToolResult."""
        return ToolResult(success=True, content=content)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "retrieve_from_knowledge_base",
            "description": "Searches the project's knowledge base (documents previously uploaded) for text chunks relevant to the query. Use this to find specific information, context, or answers contained within the project documents.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query_text": {
                        "type": "string",
                        "description": "The specific question or topic to search for in the knowledge base."
                    },
                    "top_k": {
                        "type": "integer",
                        "description": "The maximum number of relevant text chunks to retrieve.",
                        "default": 3
                    }
                },
                "required": ["query_text"]
            }
        }
    })
    @xml_schema(
        tag_name="retrieve-from-knowledge-base",
        mappings=[
            {"param_name": "query_text", "node_type": "element", "path": "."},
            {"param_name": "top_k", "node_type": "attribute", "path": ".", "required": False}
        ],
        example='''
        <retrieve-from-knowledge-base top_k="5">
        What are the key features mentioned in the project proposal document?
        </retrieve-from-knowledge-base>
        '''
    )
    async def retrieve_from_knowledge_base(self, query_text: str, top_k: int = 3) -> ToolResult:
        """Retrieves the top_k most relevant text chunks from the knowledge base for the given query."""
        logger.info(f"KB Tool: Retrieving top {top_k} chunks for project {self.project_id} with query: '{query_text[:50]}...'")
        
        if not query_text:
            return self.fail_response("Query text cannot be empty.")
        
        if top_k <= 0:
            return self.fail_response("top_k must be a positive integer.")

        embedding_model = config.EMBEDDING_MODEL_TO_USE
        
        MODEL_DIMENSIONS = {
            "text-embedding-ada-002": 1536,
            "intfloat/multilingual-e5-large": 1024,
            "sentence-transformers/all-MiniLM-L6-v2": 384, # common alternative
            # Add other models and their dimensions as needed
        }
        expected_dimension = MODEL_DIMENSIONS.get(embedding_model)

        if not expected_dimension:
             logger.warning(f"KB Tool: Could not determine expected embedding dimension for model '{embedding_model}' from known list. Ensure this model is supported and its dimension is configured if it's a new model. Vector search might fail if dimension mismatch occurs.")
        else:
            logger.info(f"KB Tool: Using embedding model '{embedding_model}' with expected dimension {expected_dimension}.")

        try:
            # 1. Get DB Client
            db = await self._get_db_client()

            # 2. Generate Query Embedding
            logger.debug(f"KB Tool: Generating embedding for query using model {embedding_model}...")
            try:
                response = await embedding(model=embedding_model, input=[query_text])
                query_embedding = response.data[0]["embedding"]
                logger.debug(f"KB Tool: Embedding generated successfully.")
            except litellm_exceptions.AuthenticationError as e_auth:
                logger.error(f"KB Tool: Authentication error with embedding service: {e_auth}", exc_info=True)
                return self.fail_response(f"Failed to generate query embedding: Authentication error with embedding service. Please check API keys.")
            except (
                litellm_exceptions.APIConnectionError,
                litellm_exceptions.Timeout,
                litellm_exceptions.ServiceUnavailableError,
                litellm_exceptions.RateLimitError,
                litellm_exceptions.APIError # General API error from LiteLLM
            ) as e_embed_service:
                logger.error(f"KB Tool: Error connecting to or using embedding service: {e_embed_service}", exc_info=True)
                return self.fail_response(f"Failed to generate query embedding: Embedding service error ({type(e_embed_service).__name__}). Please try again later.")
            except Exception as e_embed_generic: # Catch any other unexpected error during embedding
                logger.error(f"KB Tool: Unexpected error generating query embedding: {e_embed_generic}", exc_info=True)
                return self.fail_response(f"Failed to generate query embedding due to an unexpected error.")

            # 3. Perform Vector Search using RPC function
            # It's generally recommended to create a DB function for this.
            # Let's define the function name we expect: match_kb_chunks
            rpc_params = {
                'p_project_id': str(self.project_id),
                'query_embedding': query_embedding, 
                'match_count': top_k,
                'match_threshold': 0.7, # Example threshold (Cosine Similarity >= 0.7)
                                       # Adjust this threshold based on experimentation.
                'p_ef_search': 60      # HNSW ef_search parameter (default in SQL function is 60)
            }
            
            logger.debug(f"KB Tool: Calling RPC 'match_kb_chunks' with params: project_id={rpc_params['p_project_id']}, match_count={rpc_params['match_count']}, threshold={rpc_params['match_threshold']}, ef_search={rpc_params['p_ef_search']}")
            
            # Check if function exists before calling?
            # For now, assume it exists.
            search_response = None # Initialize before try block
            try:
                search_response = await db.rpc(
                    'match_kb_chunks', 
                    rpc_params
                ).execute()
            except PostgrestAPIError as e_rpc:
                logger.error(f"KB Tool: RPC call 'match_kb_chunks' failed with PostgrestAPIError: {e_rpc.message} (Code: {e_rpc.code}, Hint: {e_rpc.hint}, Details: {e_rpc.details if hasattr(e_rpc, 'details') else 'N/A'})", exc_info=True)
                # Try to provide a somewhat user-friendly message
                error_message = f"Knowledge base search failed: Database error ({e_rpc.message or 'details unavailable'})."
                if e_rpc.hint:
                    error_message += f" Hint: {e_rpc.hint}"
                return self.fail_response(error_message)
            except Exception as e_rpc_generic: # Catch other unexpected errors during RPC call
                logger.error(f"KB Tool: Unexpected error during RPC call 'match_kb_chunks': {e_rpc_generic}", exc_info=True)
                return self.fail_response("Knowledge base search failed due to an unexpected network or database error during RPC call.")

            if not hasattr(search_response, 'data') or search_response.data is None:
                 logger.error(f"KB Tool: RPC call 'match_kb_chunks' failed or returned unexpected data: {search_response}")
                 # Attempt raw SQL as fallback?
                 return self.fail_response("Failed to execute knowledge base search (RPC error).")

            results = search_response.data
            logger.info(f"KB Tool: Found {len(results)} relevant chunks via RPC.")

            if not results:
                return self.success_response("No relevant information found in the knowledge base for this query.")
            
            # --- Re-ranking Step --- 
            reranked_results = results # Default to original results if reranking fails or is skipped
            if self._reranker_model and results:
                try:
                    logger.debug(f"KB Tool: Preparing {len(results)} candidates for reranking.")
                    # Prepare pairs for the cross-encoder: (query, chunk_text)
                    pairs = [(query_text, result.get('chunk_text', '')) for result in results]
                    
                    logger.debug(f"KB Tool: Running cross-encoder prediction...")
                    # Predict scores
                    rerank_scores = self._reranker_model.predict(pairs, show_progress_bar=False)
                    logger.debug(f"KB Tool: Reranking scores obtained.")

                    # Add scores to results and sort
                    for i, result in enumerate(results):
                        result['rerank_score'] = rerank_scores[i]
                    
                    # Sort by rerank_score descending
                    reranked_results = sorted(results, key=lambda x: x.get('rerank_score', -float('inf')), reverse=True)
                    logger.info(f"KB Tool: Successfully reranked {len(reranked_results)} results.")

                except Exception as e_rerank:
                    logger.error(f"KB Tool: Error during reranking process: {e_rerank}", exc_info=True)
                    # Fallback to using the original results if reranking fails
                    reranked_results = results 
            elif not self._reranker_model:
                logger.warning("KB Tool: Reranker model not loaded. Skipping reranking step.")
            # -------------------------

            # 4. Format Results (using reranked_results)
            # Combine the text chunks into a single string for the agent's context
            # Add source info for clarity?
            context_str = """Relevant information from Knowledge Base:"""
            for i, item in enumerate(reranked_results):
                chunk_text = item.get('chunk_text', '')
                similarity = item.get('similarity', 'N/A')
                rerank_score = item.get('rerank_score', 'N/A') # Get rerank score if available
                doc_name = item.get('metadata', {}).get('file_name', 'Unknown Document')
                chunk_num = item.get('metadata', {}).get('chunk_number', 'N/A')
                
                context_str += f"--- Source: {doc_name} (Chunk {chunk_num}) | Initial Similarity: {similarity:.4f} | Rerank Score: {(f'{rerank_score:.4f}' if isinstance(rerank_score, float) else rerank_score)} ---\n"
                context_str += chunk_text
                context_str += "\n\n"
                
            return self.success_response(context_str.strip())

        except Exception as e:
            logger.error(f"KB Tool: Error during knowledge base retrieval for project {self.project_id}: {e}", exc_info=True)
            return self.fail_response(f"An error occurred while searching the knowledge base: {str(e)}")

# Example of how to add this tool (in agent/run.py or similar):
# async def setup_agent_tools(thread_manager, project_id, ...):
#     db_conn = await get_db_connection()
#     db_client = await db_conn.client
#     # ... other tools
#     kb_retriever = KnowledgeRetrievalTool(project_id=project_id, db=db_client)
#     thread_manager.add_tool_instance(kb_retriever) # Assuming add_tool_instance exists 