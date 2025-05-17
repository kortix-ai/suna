from tavily import AsyncTavilyClient
from dotenv import load_dotenv
from agentpress.tool import Tool, ToolResult, openapi_schema, xml_schema
from utils.config import config
from sandbox.tool_base import SandboxToolsBase
from agentpress.thread_manager import ThreadManager
import json
import logging
import asyncio

class SandboxWebSearchTool(SandboxToolsBase):
    """Tool for performing web searches using Tavily API."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        # Load environment variables
        load_dotenv()
        # Use API key from config
        self.tavily_api_key = config.TAVILY_API_KEY
        
        if not self.tavily_api_key:
            raise ValueError("TAVILY_API_KEY not found in configuration")

        # Tavily asynchronous search client
        self.tavily_client = AsyncTavilyClient(api_key=self.tavily_api_key)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for up-to-date information on a specific topic using the Tavily API. This tool allows you to gather real-time information from the internet to answer user queries, research topics, validate facts, and find recent developments. Results include titles, URLs, and publication dates. Use this tool for discovering relevant web pages before potentially crawling them for complete content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query to find relevant web pages. Be specific and include key terms to improve search accuracy. For best results, use natural language questions or keyword combinations that precisely describe what you're looking for."
                    },
                    "num_results": {
                        "type": "integer",
                        "description": "The number of search results to return. Increase for more comprehensive research or decrease for focused, high-relevance results.",
                        "default": 20
                    }
                },
                "required": ["query"]
            }
        }
    })
    @xml_schema(
        tag_name="web-search",
        mappings=[
            {"param_name": "query", "node_type": "attribute", "path": "."},
            {"param_name": "num_results", "node_type": "attribute", "path": "."}
        ],
        example='''
        <!-- 
        The web-search tool allows you to search the internet for real-time information.
        Use this tool when you need to find current information, research topics, or verify facts.
        
        THE TOOL NOW RETURNS:
        - Direct answer to your query from search results
        - Relevant images when available
        - Detailed search results including titles, URLs, and snippets
        
        WORKFLOW RECOMMENDATION:
        1. Use web-search first with a specific question to get direct answers
        2. Then use either scrape-graph or firecrawl to extract content from specific pages
        3. Only use browser tools if dynamic interaction is needed
        -->
        
        <!-- Simple search example -->
        <web-search 
            query="what is Kortix AI and what are they building?" 
            num_results="20">
        </web-search>
        
        <!-- Another search example -->
        <web-search 
            query="latest AI research on transformer models" 
            num_results="20">
        </web-search>
        '''
    )
    async def web_search(
        self, 
        query: str,
        num_results: int = 20
    ) -> ToolResult:
        """
        Search the web using the Tavily API to find relevant and up-to-date information.
        """
        try:
            # Ensure we have a valid query
            if not query or not isinstance(query, str):
                return self.fail_response("A valid search query is required.")
            
            # Normalize num_results
            if num_results is None:
                num_results = 20
            elif isinstance(num_results, int):
                num_results = max(1, min(num_results, 50))
            elif isinstance(num_results, str):
                try:
                    num_results = max(1, min(int(num_results), 50))
                except ValueError:
                    num_results = 20
            else:
                num_results = 20

            # Execute the search with Tavily
            logging.info(f"Executing web search for query: '{query}' with {num_results} results")
            search_response = await self.tavily_client.search(
                query=query,
                max_results=num_results,
                include_images=True,
                include_answer="advanced",
                search_depth="advanced",
            )
            
            # Return the complete Tavily response 
            # This includes the query, answer, results, images and more
            logging.info(f"Retrieved search results for query: '{query}' with answer and {len(search_response.get('results', []))} results")
            
            return ToolResult(
                success=True,
                output=json.dumps(search_response, ensure_ascii=False)
            )
        
        except Exception as e:
            error_message = str(e)
            logging.error(f"Error performing web search for '{query}': {error_message}")
            simplified_message = f"Error performing web search: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)

if __name__ == "__main__":
    async def test_web_search():
        """Test function for the web search tool"""
        # This test function is not compatible with the sandbox version
        print("Test function needs to be updated for sandbox version")
    
    async def run_tests():
        """Run all test functions"""
        await test_web_search()
        
    asyncio.run(run_tests())
