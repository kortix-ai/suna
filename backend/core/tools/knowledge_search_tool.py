"""
Knowledge search tool for agents using LlamaCloud indices.

This tool allows agents to search through configured knowledge bases
using LlamaCloud's managed indices with dynamic function generation.
"""

import os
from typing import Dict, Any, List, Optional
from agentpress.tool import Tool, ToolResult, openapi_schema
from agentpress.thread_manager import ThreadManager
from utils.logger import logger
import json


class KnowledgeSearchTool(Tool):
    """
    Tool for searching knowledge bases using LlamaCloud indices.
    
    This tool dynamically creates search functions for each configured
    knowledge base, allowing agents to search through specific indices.
    """
    
    def __init__(self, thread_manager: ThreadManager, knowledge_bases: Optional[List[Dict[str, Any]]] = None):
        """
        Initialize the knowledge search tool.
        
        Args:
            thread_manager: ThreadManager instance for context
            knowledge_bases: List of knowledge base configurations, each containing:
                - name: Name of the tool (used for method name generation)
                - index_name: Name of the LlamaCloud index (used for API calls)
                - description: Description of what this knowledge base contains
        """
        # Don't call super().__init__() yet - we need to set up dynamic methods first
        self.thread_manager = thread_manager
        self.knowledge_bases = knowledge_bases or []
        
        # Get LlamaCloud configuration from environment
        self.api_key = os.getenv("LLAMA_CLOUD_API_KEY")
        self.project_name = os.getenv("LLAMA_CLOUD_PROJECT_NAME", "Default")
        
        if not self.api_key:
            logger.warning("LLAMA_CLOUD_API_KEY not found in environment variables")
        
        # Create dynamic search methods for each knowledge base
        self._create_dynamic_methods()
        
        # Now initialize the parent class which will call _register_schemas
        super().__init__()
    
    def _create_dynamic_methods(self):
        """Create dynamic search methods for each configured knowledge base."""
        for kb in self.knowledge_bases:
            name = kb.get('name', '')
            index_name = kb.get('index_name', '')
            description = kb.get('description', '')
            
            if not name or not index_name:
                continue
            
            # Create a safe method name from the tool name
            method_name = f"search_{name.replace('-', '_').replace(' ', '_').lower()}"
            
            # Create the search function for this specific index
            async def search_function(self, query: str, index_name=index_name, kb_description=description) -> ToolResult:
                """Search a specific knowledge base index."""
                return await self._search_index(query, index_name, kb_description)
            
            # Create OpenAPI schema for this method
            openapi_decorator = openapi_schema({
                "type": "function",
                "function": {
                    "name": method_name,
                    "description": f"Search the '{name}' knowledge base. {description}",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "The search query to find relevant information"
                            }
                        },
                        "required": ["query"]
                    }
                }
            })
            
            # Only using OpenAPI schema for agentpress compatibility
            
            # Apply decorator and bind the method
            decorated_method = openapi_decorator(search_function)
            setattr(self, method_name, decorated_method.__get__(self, type(self)))
            
            logger.info(f"Created dynamic search method: {method_name} for tool: {name} (index: {index_name})")
    
    async def _search_index(self, query: str, index_name: str, description: str) -> ToolResult:
        """
        Perform a search on a specific LlamaCloud index.
        
        Args:
            query: The search query
            index_name: Name of the index to search
            description: Description of the knowledge base (for context)
            
        Returns:
            ToolResult with search results
        """
        try:
            if not self.api_key:
                return self.fail_response("LlamaCloud API key not configured. Please set LLAMA_CLOUD_API_KEY environment variable.")
            
            # Import LlamaCloud client here to avoid dependency issues
            try:
                from llama_index.indices.managed.llama_cloud import LlamaCloudIndex
            except ImportError:
                return self.fail_response("LlamaCloud client not installed. Please install llama-index-indices-managed-llama-cloud")
            
            # Set the API key
            os.environ["LLAMA_CLOUD_API_KEY"] = self.api_key
            
            logger.info(f"Searching index '{index_name}' with query: {query}")
            
            # Connect to the index
            index = LlamaCloudIndex(index_name, project_name=self.project_name)
            
            # Configure retriever with balanced settings
            retriever = index.as_retriever(
                dense_similarity_top_k=3,
                sparse_similarity_top_k=3,
                alpha=0.5,  # Balance between dense and sparse
                enable_reranking=True,
                rerank_top_n=3,
                retrieval_mode="chunks",  # Can be enabled for better results
            )
            
            # Perform the search
            nodes = retriever.retrieve(query)
            
            if not nodes:
                return self.success_response({
                    "message": f"No results found in '{index_name}' for query: {query}",
                    "results": [],
                    "index": index_name,
                    "description": description
                })
            
            # Format the results
            results = []
            for i, node in enumerate(nodes):
                result = {
                    "rank": i + 1,
                    "score": node.score,
                    "text": node.text,
                    "metadata": node.metadata if hasattr(node, 'metadata') else {}
                }
                results.append(result)
            
            return self.success_response({
                "message": f"Found {len(results)} results in '{index_name}'",
                "results": results,
                "index": index_name,
                "description": description,
                "query": query
            })
            
        except Exception as e:
            logger.error(f"Error searching index '{index_name}': {str(e)}")
            return self.fail_response(f"Error searching knowledge base '{index_name}': {str(e)}")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_available_knowledge_bases",
            "description": "List all available knowledge bases and their descriptions",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })

    async def list_available_knowledge_bases(self) -> ToolResult:
        """List all available knowledge bases and their descriptions."""
        try:
            if not self.knowledge_bases:
                return self.success_response({
                    "message": "No knowledge bases configured",
                    "knowledge_bases": []
                })
            
            kb_list = []
            for kb in self.knowledge_bases:
                kb_info = {
                    "name": kb.get('name'),
                    "index_name": kb.get('index_name'),
                    "description": kb.get('description', 'No description provided'),
                    "search_method": f"search_{kb.get('name', '').replace('-', '_').replace(' ', '_').lower()}"
                }
                kb_list.append(kb_info)
            
            return self.success_response({
                "message": f"Found {len(kb_list)} knowledge bases",
                "knowledge_bases": kb_list
            })
            
        except Exception as e:
            logger.error(f"Error listing knowledge bases: {str(e)}")
            return self.fail_response(f"Error listing knowledge bases: {str(e)}")