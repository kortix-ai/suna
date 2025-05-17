from tavily import AsyncTavilyClient
import httpx
from dotenv import load_dotenv
from agentpress.tool import Tool, ToolResult, openapi_schema, xml_schema
from utils.config import config
from sandbox.tool_base import SandboxToolsBase
from agentpress.thread_manager import ThreadManager
from utils.logger import logger
import json
import os
import datetime
import asyncio
import logging
from typing import List

# TODO: add subpages, etc... in filters as sometimes its necessary 

class SandboxWebSearchTool(SandboxToolsBase):
    """Tool for performing web searches using Tavily API and web scraping using Firecrawl."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.thread_manager = thread_manager
        self.memory_tool = None
        self._initialized = False
        # Load environment variables
        load_dotenv()
        # Use API keys from config
        self.tavily_api_key = config.TAVILY_API_KEY
        self.firecrawl_api_key = config.FIRECRAWL_API_KEY
        self.firecrawl_url = config.FIRECRAWL_URL
        
        if not self.tavily_api_key:
            raise ValueError("TAVILY_API_KEY not found in configuration")
        if not self.firecrawl_api_key:
            raise ValueError("FIRECRAWL_API_KEY not found in configuration")

        # Tavily asynchronous search client
        self.tavily_client = AsyncTavilyClient(api_key=self.tavily_api_key)

    async def _ensure_initialized(self):
        """Ensure the memory tool is initialized."""
        if not self._initialized:
            try:
                # Get memory tool from thread manager's tool registry
                from agent.tools.memory_tool import MemoryTool  # Import here to avoid circular imports
                tool_info = self.thread_manager.tool_registry.get_tool("save-memory")  # Get tool by function name
                if tool_info and 'instance' in tool_info:
                    self.memory_tool = tool_info['instance']
                    logger.info("Successfully initialized memory tool")
                else:
                    logger.warning("Memory tool not available for web search")
                self._initialized = True
            except Exception as e:
                logger.error(f"Failed to initialize memory tool: {e}")
                # Continue without memory tool
                self._initialized = True  # Mark as initialized to prevent repeated attempts

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
        2. Only use scrape-webpage if you need more detailed information from specific pages
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
        """Search the web using Tavily API."""
        try:
            # First, check if we have relevant memories about this topic
            if self.memory_tool:
                try:
                    # Retrieve relevant memories before searching
                    memory_results = await self.memory_tool.retrieve_memories(
                        thread_id=self.thread_manager.current_thread_id,
                        query=query,
                        memory_types=["semantic", "episodic"],
                        tags=["web_search", "research"],
                        limit=3,
                        min_importance=0.5
                    )
                    
                    if memory_results.get("memories"):
                        logger.info(f"Found {len(memory_results['memories'])} relevant memories for search query")
                        # We'll use these memories to enhance our search results later
                except Exception as e:
                    logger.error(f"Failed to retrieve memories for search: {e}")

            # Perform the web search
            search_results = await self._perform_search(query, num_results)
            
            if not search_results:
                return self.fail_response("No search results found")

            # Store search results in memory
            if self.memory_tool:
                try:
                    # Create a semantic memory of the search results
                    memory_content = f"Web Search Results for: {query}\n\n"
                    
                    # Add direct answer if available
                    if search_results.get("answer"):
                        memory_content += f"Direct Answer:\n{search_results['answer']}\n\n"
                    
                    # Add top results summary
                    memory_content += "Top Results:\n"
                    for idx, result in enumerate(search_results.get("results", [])[:5], 1):
                        memory_content += f"{idx}. {result.get('title', 'No title')}\n"
                        memory_content += f"   URL: {result.get('url', 'No URL')}\n"
                        if result.get("snippet"):
                            memory_content += f"   {result['snippet'][:200]}...\n"
                        memory_content += "\n"
                    
                    # Save to memory with importance based on result quality
                    importance_score = 0.6  # Default
                    if search_results.get("answer") or len(search_results.get("results", [])) > 5:
                        importance_score = 0.7
                    
                    await self.memory_tool.save_memory(
                        thread_id=self.thread_manager.current_thread_id,
                        content=memory_content,
                        memory_type="semantic",
                        importance_score=importance_score,
                        tags=["web_search", "research", "information"],
                        metadata={
                            "query": query,
                            "timestamp": datetime.datetime.now().isoformat(),
                            "result_count": len(search_results.get("results", [])),
                            "has_direct_answer": bool(search_results.get("answer")),
                            "has_images": bool(search_results.get("images"))
                        }
                    )
                except Exception as e:
                    logger.error(f"Failed to store search results in memory: {e}")

            return self.success_response(search_results)
        except Exception as e:
            return self.fail_response(f"Web search failed: {e}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "scrape_webpage",
            "description": "Extract full text content from multiple webpages in a single operation. IMPORTANT: You should ALWAYS collect multiple relevant URLs from web-search results and scrape them all in a single call for efficiency. This tool saves time by processing multiple pages simultaneously rather than one at a time. The extracted text includes the main content of each page without HTML markup.",
            "parameters": {
                "type": "object",
                "properties": {
                    "urls": {
                        "type": "string",
                        "description": "Multiple URLs to scrape, separated by commas. You should ALWAYS include several URLs when possible for efficiency. Example: 'https://example.com/page1,https://example.com/page2,https://example.com/page3'"
                    }
                },
                "required": ["urls"]
            }
        }
    })
    @xml_schema(
        tag_name="scrape-webpage",
        mappings=[
            {"param_name": "urls", "node_type": "attribute", "path": "."}
        ],
        example='''
  <!-- 
        IMPORTANT: The scrape-webpage tool should ONLY be used when you absolutely need
        the full content of specific web pages that can't be answered by web-search alone.
        
        WORKFLOW PRIORITY:
        1. ALWAYS use web-search first - it now provides direct answers to questions
        2. Only use scrape-webpage when you need specific details not found in the search results
        3. Remember that web-search now returns:
           - Direct answers to your query
           - Relevant images
           - Detailed search result snippets
        
        When to use scrape-webpage:
        - When you need complete article text beyond what search snippets provide
        - For extracting structured data from specific pages
        - When analyzing lengthy documentation or guides
        - For comparing detailed content across multiple sources
        
        When NOT to use scrape-webpage:
        - When web-search already answers the query
        - For simple fact-checking or basic information
        - When only a high-level overview is needed
        -->
        
        <!-- Example workflow: -->
        <!-- 1. First search for relevant content with a specific question -->
        <web-search 
            query="what is Kortix AI and what are they building?" 
            num_results="20">
        </web-search>
        
        <!-- 2. Only if you need specific details not in the search results, then scrape -->
        <scrape-webpage 
            urls="https://www.kortix.ai/,https://github.com/kortix-ai/suna">
        </scrape-webpage>
        
        <!-- 3. Only if scrape fails or interaction needed, use browser tools -->
        <!-- Example of when to use browser tools:
             - Dynamic content loading
             - JavaScript-heavy sites
             - Pages requiring login
             - Interactive elements
             - Infinite scroll pages
        -->
        '''
    )
    async def scrape_webpage(
        self,
        urls: str,
        thread_id: str = None
    ) -> ToolResult:
        """Scrape content from web pages."""
        try:
            # Ensure tools are initialized
            await self._ensure_sandbox()
            await self._ensure_initialized()
            
            # Get thread ID from the most recent message if not provided
            if thread_id is None:
                try:
                    client = await self.thread_manager.db.client
                    result = await client.table('messages').select('thread_id').order('created_at', desc=True).limit(1).execute()
                    if result.data and len(result.data) > 0:
                        thread_id = result.data[0]['thread_id']
                    else:
                        logger.warning("No thread ID found in recent messages")
                        return self.fail_response("No thread ID available for memory storage")
                except Exception as e:
                    logger.error(f"Failed to get thread ID: {e}")
                    return self.fail_response("Failed to get thread ID for memory storage")
            
            # Process URLs and get results
            results = await self._process_urls(urls)
            
            # Store scraped content in memory if memory tool is available
            if self.memory_tool and thread_id and results:
                try:
                    for result in results:
                        if result.get("success") and result.get("title"):
                            # Create a semantic memory of the scraped content
                            memory_content = f"Scraped content from: {result['title']}\n"
                            memory_content += f"URL: {result['url']}\n\n"
                            
                            # Store first 1000 characters of content as summary
                            if result.get("text"):
                                summary = result["text"][:1000] + "..." if len(result["text"]) > 1000 else result["text"]
                                memory_content += f"Content Summary:\n{summary}\n"
                            
                            # Save to memory
                            await self.memory_tool.save_memory(
                                thread_id=thread_id,
                                content=memory_content,
                                memory_type="semantic",
                                importance_score=0.7,
                                tags=["web_scrape", "research", "content"],
                                metadata={
                                    "url": result["url"],
                                    "title": result["title"],
                                    "timestamp": datetime.datetime.now().isoformat(),
                                    "content_length": result.get("content_length", 0)
                                }
                            )
                    logger.info(f"Successfully stored scraped content in memory for thread {thread_id}")
                except Exception as e:
                    logger.error(f"Failed to store scraped content in memory: {e}")
            
            # Return original response
            return self._create_scrape_response(results)
            
        except Exception as e:
            error_message = str(e)
            logger.error(f"Error in scrape_webpage: {error_message}")
            return self.fail_response(f"Error processing scrape request: {error_message[:200]}")
    
    async def _scrape_single_url(self, url: str) -> dict:
        """
        Helper function to scrape a single URL and return the result information.
        """
        logging.info(f"Scraping single URL: {url}")
        
        try:
            # ---------- Firecrawl scrape endpoint ----------
            logging.info(f"Sending request to Firecrawl for URL: {url}")
            async with httpx.AsyncClient() as client:
                headers = {
                    "Authorization": f"Bearer {self.firecrawl_api_key}",
                    "Content-Type": "application/json",
                }
                payload = {
                    "url": url,
                    "formats": ["markdown"]
                }
                
                # Use longer timeout and retry logic for more reliability
                max_retries = 3
                timeout_seconds = 120
                retry_count = 0
                
                while retry_count < max_retries:
                    try:
                        logging.info(f"Sending request to Firecrawl (attempt {retry_count + 1}/{max_retries})")
                        response = await client.post(
                            f"{self.firecrawl_url}/v1/scrape",
                            json=payload,
                            headers=headers,
                            timeout=timeout_seconds,
                        )
                        response.raise_for_status()
                        data = response.json()
                        logging.info(f"Successfully received response from Firecrawl for {url}")
                        break
                    except (httpx.ReadTimeout, httpx.ConnectTimeout, httpx.ReadError) as timeout_err:
                        retry_count += 1
                        logging.warning(f"Request timed out (attempt {retry_count}/{max_retries}): {str(timeout_err)}")
                        if retry_count >= max_retries:
                            raise Exception(f"Request timed out after {max_retries} attempts with {timeout_seconds}s timeout")
                        # Exponential backoff
                        logging.info(f"Waiting {2 ** retry_count}s before retry")
                        await asyncio.sleep(2 ** retry_count)
                    except Exception as e:
                        # Don't retry on non-timeout errors
                        logging.error(f"Error during scraping: {str(e)}")
                        raise e

            # Format the response
            title = data.get("data", {}).get("metadata", {}).get("title", "")
            markdown_content = data.get("data", {}).get("markdown", "")
            logging.info(f"Extracted content from {url}: title='{title}', content length={len(markdown_content)}")
            
            formatted_result = {
                "title": title,
                "url": url,
                "text": markdown_content
            }
            
            # Add metadata if available
            if "metadata" in data.get("data", {}):
                formatted_result["metadata"] = data["data"]["metadata"]
                logging.info(f"Added metadata: {data['data']['metadata'].keys()}")
            
            # Create a simple filename from the URL domain and date
            timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            
            # Extract domain from URL for the filename
            from urllib.parse import urlparse
            parsed_url = urlparse(url)
            domain = parsed_url.netloc.replace("www.", "")
            
            # Clean up domain for filename
            domain = "".join([c if c.isalnum() else "_" for c in domain])
            safe_filename = f"{timestamp}_{domain}.json"
            
            logging.info(f"Generated filename: {safe_filename}")
            
            # Save results to a file in the /workspace/scrape directory
            scrape_dir = f"{self.workspace_path}/scrape"
            self.sandbox.fs.create_folder(scrape_dir, "755")
            
            results_file_path = f"{scrape_dir}/{safe_filename}"
            json_content = json.dumps(formatted_result, ensure_ascii=False, indent=2)
            logging.info(f"Saving content to file: {results_file_path}, size: {len(json_content)} bytes")
            
            self.sandbox.fs.upload_file(
                results_file_path, 
                json_content.encode()
            )
            
            return {
                "url": url,
                "success": True,
                "title": title,
                "file_path": results_file_path,
                "content_length": len(markdown_content)
            }
        
        except Exception as e:
            error_message = str(e)
            logging.error(f"Error scraping URL '{url}': {error_message}")
            
            # Create an error result
            return {
                "url": url,
                "success": False,
                "error": error_message
            }

    async def _perform_search(self, query: str, num_results: int = 20) -> dict:
        """Perform a web search using Tavily API.
        
        Args:
            query: The search query
            num_results: Number of results to return
            
        Returns:
            dict: Search results including direct answer and web pages
        """
        try:
            logger.info(f"Performing web search for query: {query}")
            
            # Perform the search using Tavily
            search_response = await self.tavily_client.search(
                query=query,
                search_depth="advanced",
                max_results=num_results,
                include_answer=True,
                include_images=True
            )
            
            # Format the response
            results = {
                "answer": search_response.get("answer", ""),
                "results": []
            }
            
            # Process each result
            for result in search_response.get("results", []):
                formatted_result = {
                    "title": result.get("title", ""),
                    "url": result.get("url", ""),
                    "snippet": result.get("content", ""),
                    "published_date": result.get("published_date", ""),
                    "score": result.get("score", 0)
                }
                results["results"].append(formatted_result)
            
            # Add images if available
            if "images" in search_response:
                results["images"] = search_response["images"]
            
            logger.info(f"Search completed successfully. Found {len(results['results'])} results")
            return results
            
        except Exception as e:
            error_message = str(e)
            logger.error(f"Error in _perform_search: {error_message}")
            raise Exception(f"Search failed: {error_message}")

    async def _process_urls(self, urls: str) -> List[dict]:
        """Process multiple URLs for scraping.
        
        Args:
            urls: Comma-separated list of URLs to scrape
            
        Returns:
            List of scraping results for each URL
        """
        url_list = [url.strip() for url in urls.split(",")]
        results = []
        
        for url in url_list:
            try:
                result = await self._scrape_single_url(url)
                results.append(result)
            except Exception as e:
                logger.error(f"Error scraping URL {url}: {str(e)}")
                results.append({
                    "url": url,
                    "success": False,
                    "error": str(e)
                })
        
        return results

    def _create_scrape_response(self, results: List[dict]) -> ToolResult:
        """Create a formatted response for scrape results.
        
        Args:
            results: List of scraping results
            
        Returns:
            ToolResult with formatted response
        """
        # Count successes and failures
        success_count = sum(1 for r in results if r.get("success", False))
        failure_count = len(results) - success_count
        
        # Create response data
        response_data = {
            "success": success_count > 0,  # Overall success if at least one URL succeeded
            "total_urls": len(results),
            "successful_urls": success_count,
            "failed_urls": failure_count,
            "results": results
        }
        
        # Create success/failure message
        if success_count > 0:
            message = f"Successfully scraped {success_count} out of {len(results)} URLs"
            if failure_count > 0:
                message += f" ({failure_count} failed)"
        else:
            message = f"Failed to scrape any of the {len(results)} URLs"
        
        return self.success_response({
            "message": message,
            **response_data
        })

if __name__ == "__main__":
    async def test_web_search():
        """Test function for the web search tool"""
        # This test function is not compatible with the sandbox version
        print("Test function needs to be updated for sandbox version")
    
    async def test_scrape_webpage():
        """Test function for the webpage scrape tool"""
        # This test function is not compatible with the sandbox version
        print("Test function needs to be updated for sandbox version")
    
    async def run_tests():
        """Run all test functions"""
        await test_web_search()
        await test_scrape_webpage()
        
    asyncio.run(run_tests())