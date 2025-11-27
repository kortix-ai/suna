from tavily import AsyncTavilyClient
import httpx
from dotenv import load_dotenv
from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.utils.config import config
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
import json
import datetime
import asyncio
import logging
import time

# TODO: add subpages, etc... in filters as sometimes its necessary 

@tool_metadata(
    display_name="Web Search",
    description="Search the internet for information, news, and research",
    icon="Search",
    color="bg-green-100 dark:bg-green-800/50",
    weight=30,
    visible=True
)
class SandboxWebSearchTool(SandboxToolsBase):
    """Tool for performing web searches using Tavily API and web scraping using Firecrawl."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        # Load environment variables
        load_dotenv()
        # Use API keys from config
        self.tavily_api_key = config.TAVILY_API_KEY
        self.firecrawl_api_key = config.FIRECRAWL_API_KEY
        self.firecrawl_url = config.FIRECRAWL_URL
        
        if not self.tavily_api_key:
            logging.warning("TAVILY_API_KEY not configured - Web Search Tool will not be available")
        if not self.firecrawl_api_key:
            logging.warning("FIRECRAWL_API_KEY not configured - Web Scraping Tool will not be available")

        # Tavily asynchronous search client
        self.tavily_client = AsyncTavilyClient(api_key=self.tavily_api_key)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for up-to-date information using the Tavily API. This tool supports both single and batch queries for efficient research. You can search for multiple topics simultaneously by providing an array of queries, which executes searches concurrently for faster results. Use batch mode when researching multiple related topics, gathering comprehensive information, or performing parallel searches. Results include titles, URLs, publication dates, direct answers, and images. Use this tool for discovering relevant web pages before potentially crawling them for complete content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "oneOf": [
                            {
                                "type": "string",
                                "description": "A single search query to find relevant web pages. Be specific and include key terms to improve search accuracy. For best results, use natural language questions or keyword combinations that precisely describe what you're looking for."
                            },
                            {
                                "type": "array",
                                "items": {
                                    "type": "string"
                                },
                                "description": "Multiple search queries to execute concurrently. Use this for batch searching when you need to research multiple related topics simultaneously. Each query will be processed in parallel for faster results. Example: [\"topic overview\", \"use cases\", \"user demographics\"]"
                            }
                        ],
                        "description": "Either a single search query (string) or multiple queries (array of strings) to execute concurrently. Use batch mode (array) for faster research when investigating multiple aspects of a topic."
                    },
                    "num_results": {
                        "type": "integer",
                        "description": "The number of search results to return per query. Increase for more comprehensive research or decrease for focused, high-relevance results. Applies to each query when using batch mode.",
                        "default": 5
                    }
                },
                "required": ["query"]
            }
        }
    })
    async def web_search(
        self, 
        query: str | list[str],
        num_results: int = 5
    ) -> ToolResult:
        """
        Search the web using the Tavily API to find relevant and up-to-date information.
        Supports both single queries and batch queries for concurrent execution.
        """
        try:
            # Check if Tavily API key is configured
            if not self.tavily_api_key:
                return self.fail_response("Web Search is not available. TAVILY_API_KEY is not configured.")
            
            # Normalize num_results
            if num_results is None:
                num_results = 10
            elif isinstance(num_results, int):
                num_results = max(1, min(num_results, 50))
            elif isinstance(num_results, str):
                try:
                    num_results = max(1, min(int(num_results), 50))
                except ValueError:
                    num_results = 10
            else:
                num_results = 10

            # Determine if this is a batch query or single query
            is_batch = isinstance(query, list)
            
            if is_batch:
                # Batch mode: process multiple queries concurrently
                if not query or len(query) == 0:
                    return self.fail_response("At least one search query is required in the batch.")
                
                # Filter out empty queries
                queries = [q.strip() for q in query if q and isinstance(q, str) and q.strip()]
                if not queries:
                    return self.fail_response("No valid search queries provided in the batch.")
                
                logging.info(f"Executing batch web search for {len(queries)} queries with {num_results} results each")
                
                # Execute all searches concurrently
                start_time = time.time()
                tasks = [
                    self._execute_single_search(q, num_results) 
                    for q in queries
                ]
                search_results = await asyncio.gather(*tasks, return_exceptions=True)
                elapsed_time = time.time() - start_time
                logging.info(f"Batch search completed in {elapsed_time:.2f}s (concurrent execution)")
                
                # Process results and handle exceptions
                batch_response = {
                    "batch_mode": True,
                    "total_queries": len(queries),
                    "results": []
                }
                
                all_successful = True
                for i, result in enumerate(search_results):
                    if isinstance(result, Exception):
                        logging.error(f"Error processing query '{queries[i]}': {str(result)}")
                        batch_response["results"].append({
                            "query": queries[i],
                            "success": False,
                            "error": str(result),
                            "results": [],
                            "answer": ""
                        })
                        all_successful = False
                    else:
                        batch_response["results"].append({
                            "query": queries[i],
                            "success": result.get("success", False),
                            "results": result.get("results", []),
                            "answer": result.get("answer", ""),
                            "images": result.get("images", []),
                            "response": result.get("response", {})
                        })
                        if not result.get("success", False):
                            all_successful = False
                
                logging.info(f"Batch search completed: {len([r for r in batch_response['results'] if r.get('success')])}/{len(queries)} queries successful")
                
                return ToolResult(
                    success=all_successful,
                    output=json.dumps(batch_response, ensure_ascii=False)
                )
            else:
                # Single query mode: original behavior
                if not query or not isinstance(query, str):
                    return self.fail_response("A valid search query is required.")
                
                query = query.strip()
                if not query:
                    return self.fail_response("A valid search query is required.")
                
                logging.info(f"Executing web search for query: '{query}' with {num_results} results")
                result = await self._execute_single_search(query, num_results)
                
                if result.get("success", False):
                    return ToolResult(
                        success=True,
                        output=json.dumps(result.get("response", {}), ensure_ascii=False)
                    )
                else:
                    logging.warning(f"No search results or answer found for query: '{query}'")
                    return ToolResult(
                        success=False,
                        output=json.dumps(result.get("response", {}), ensure_ascii=False)
                    )
        
        except Exception as e:
            error_message = str(e)
            query_str = ", ".join(query) if isinstance(query, list) else str(query)
            logging.error(f"Error performing web search for '{query_str}': {error_message}")
            simplified_message = f"Error performing web search: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)
    
    async def _execute_single_search(self, query: str, num_results: int) -> dict:
        """
        Helper function to execute a single search query.
        
        Parameters:
        - query: The search query string
        - num_results: Number of results to return
        
        Returns:
        - dict with success status, results, answer, images, and full response
        """
        try:
            search_response = await self.tavily_client.search(
                query=query,
                max_results=num_results,
                include_images=True,
                include_answer="advanced",
                search_depth="advanced",
            )
            
            # Extract results and answer
            results = search_response.get('results', [])
            answer = search_response.get('answer', '')
            images = search_response.get('images', [])
            
            # Consider search successful if we have either results OR an answer
            success = len(results) > 0 or (answer and answer.strip())
            
            logging.info(f"Retrieved search results for query: '{query}' - {len(results)} results, answer: {'yes' if answer else 'no'}")
            
            return {
                "success": success,
                "results": results,
                "answer": answer,
                "images": images,
                "response": search_response
            }
        
        except Exception as e:
            error_message = str(e)
            logging.error(f"Error executing search for '{query}': {error_message}")
            return {
                "success": False,
                "results": [],
                "answer": "",
                "images": [],
                "response": {},
                "error": error_message
            }

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "scrape_webpage",
            "description": "Extract full text content from multiple webpages in a single operation. IMPORTANT: You should ALWAYS collect multiple relevant URLs from web-search results and scrape them all in a single call for efficiency. This tool saves time by processing multiple pages simultaneously rather than one at a time. The extracted text includes the main content of each page without HTML markup by default, but can optionally include full HTML if needed for structure analysis.",
            "parameters": {
                "type": "object",
                "properties": {
                    "urls": {
                        "type": "string",
                        "description": "Multiple URLs to scrape, separated by commas. You should ALWAYS include several URLs when possible for efficiency. Example: 'https://example.com/page1,https://example.com/page2,https://example.com/page3'"
                    },
                    "include_html": {
                        "type": "boolean",
                        "description": "Whether to include the full raw HTML content alongside the extracted text. Set to true when you need to analyze page structure, extract specific HTML elements, or work with complex layouts. Default is false for cleaner text extraction.",
                        "default": False
                    }
                },
                "required": ["urls"]
            }
        }
    })
    async def scrape_webpage(
        self,
        urls: str,
        include_html: bool = False
    ) -> ToolResult:
        """
        Retrieve the complete text content of multiple webpages in a single efficient operation.
        
        ALWAYS collect multiple relevant URLs from search results and scrape them all at once
        rather than making separate calls for each URL. This is much more efficient.
        
        Parameters:
        - urls: Multiple URLs to scrape, separated by commas
        - include_html: Whether to include full HTML content alongside markdown (default: False)
        """
        try:
            # Check if Firecrawl API key is configured
            if not self.firecrawl_api_key:
                return self.fail_response("Web Scraping is not available. FIRECRAWL_API_KEY is not configured.")
            
            logging.info(f"Starting to scrape webpages: {urls}")
            
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            # Parse the URLs parameter
            if not urls:
                logging.warning("Scrape attempt with empty URLs")
                return self.fail_response("Valid URLs are required.")
            
            # Split the URLs string into a list
            url_list = [url.strip() for url in urls.split(',') if url.strip()]
            
            if not url_list:
                logging.warning("No valid URLs found in the input")
                return self.fail_response("No valid URLs provided.")
                
            if len(url_list) == 1:
                logging.warning("Only a single URL provided - for efficiency you should scrape multiple URLs at once")
            
            logging.info(f"Processing {len(url_list)} URLs: {url_list}")
            
            # Process each URL concurrently and collect results
            start_time = time.time()
            tasks = [self._scrape_single_url(url, include_html) for url in url_list]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            elapsed_time = time.time() - start_time
            logging.info(f"Scraped {len(url_list)} URLs in {elapsed_time:.2f}s (concurrent execution)")

            # Process results, handling exceptions
            processed_results = []
            for i, result in enumerate(results):
                if isinstance(result, Exception):
                    logging.error(f"Error processing URL {url_list[i]}: {str(result)}")
                    processed_results.append({
                        "url": url_list[i],
                        "success": False,
                        "error": str(result)
                    })
                else:
                    processed_results.append(result)
            
            results = processed_results

            
            # Summarize results
            successful = sum(1 for r in results if r.get("success", False))
            failed = len(results) - successful
            
            # Create success/failure message
            if successful == len(results):
                message = f"Successfully scraped all {len(results)} URLs. Results saved to:"
                for r in results:
                    if r.get("file_path"):
                        message += f"\n- {r.get('file_path')}"
            elif successful > 0:
                message = f"Scraped {successful} URLs successfully and {failed} failed. Results saved to:"
                for r in results:
                    if r.get("success", False) and r.get("file_path"):
                        message += f"\n- {r.get('file_path')}"
                message += "\n\nFailed URLs:"
                for r in results:
                    if not r.get("success", False):
                        message += f"\n- {r.get('url')}: {r.get('error', 'Unknown error')}"
            else:
                error_details = "; ".join([f"{r.get('url')}: {r.get('error', 'Unknown error')}" for r in results])
                return self.fail_response(f"Failed to scrape all {len(results)} URLs. Errors: {error_details}")
            
            return ToolResult(
                success=True,
                output=message
            )
        
        except Exception as e:
            error_message = str(e)
            logging.error(f"Error in scrape_webpage: {error_message}")
            return self.fail_response(f"Error processing scrape request: {error_message[:200]}")
    
    async def _scrape_single_url(self, url: str, include_html: bool = False) -> dict:
        """
        Helper function to scrape a single URL and return the result information.
        
        Parameters:
        - url: URL to scrape
        - include_html: Whether to include full HTML content alongside markdown
        """
        
        # # Add protocol if missing
        # if not (url.startswith('http://') or url.startswith('https://')):
        #     url = 'https://' + url
        #     logging.info(f"Added https:// protocol to URL: {url}")
            
        logging.info(f"Scraping single URL: {url}")
        
        try:
            # ---------- Firecrawl scrape endpoint ----------
            logging.info(f"Sending request to Firecrawl for URL: {url}")
            async with httpx.AsyncClient() as client:
                headers = {
                    "Authorization": f"Bearer {self.firecrawl_api_key}",
                    "Content-Type": "application/json",
                }
                # Determine formats to request based on include_html flag
                formats = ["markdown"]
                if include_html:
                    formats.append("html")
                
                payload = {
                    "url": url,
                    "formats": formats
                }
                
                # Use longer timeout and retry logic for more reliability
                max_retries = 3
                timeout_seconds = 30
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
            html_content = data.get("data", {}).get("html", "") if include_html else ""
            
            logging.info(f"Extracted content from {url}: title='{title}', content length={len(markdown_content)}" + 
                        (f", HTML length={len(html_content)}" if html_content else ""))
            
            formatted_result = {
                "title": title,
                "url": url,
                "text": markdown_content
            }
            
            # Add HTML content if requested and available
            if include_html and html_content:
                formatted_result["html"] = html_content
            
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
            await self.sandbox.fs.create_folder(scrape_dir, "755")
            
            results_file_path = f"{scrape_dir}/{safe_filename}"
            json_content = json.dumps(formatted_result, ensure_ascii=False, indent=2)
            logging.info(f"Saving content to file: {results_file_path}, size: {len(json_content)} bytes")
            
            await self.sandbox.fs.upload_file(
                json_content.encode(),
                results_file_path,
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