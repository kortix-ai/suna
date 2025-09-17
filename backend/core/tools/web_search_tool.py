from tavily import AsyncTavilyClient
import httpx
from dotenv import load_dotenv
from core.agentpress.tool import Tool, ToolResult, openapi_schema, usage_example
from core.utils.config import config
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
import json
import os
import datetime
import asyncio
import logging
from typing import Union, List

# TODO: add subpages, etc... in filters as sometimes its necessary 

class SandboxWebSearchTool(SandboxToolsBase):
    """Tool for performing web searches using Tavily API, image searches using SERPER API, and web scraping using Firecrawl."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        # Load environment variables
        load_dotenv()
        # Use API keys from config
        self.tavily_api_key = config.TAVILY_API_KEY
        self.firecrawl_api_key = config.FIRECRAWL_API_KEY
        self.firecrawl_url = config.FIRECRAWL_URL
        self.serper_api_key = config.SERPER_API_KEY
        
        if not self.tavily_api_key:
            raise ValueError("TAVILY_API_KEY not found in configuration")
        if not self.firecrawl_api_key:
            raise ValueError("FIRECRAWL_API_KEY not found in configuration")

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
    @usage_example('''
        <function_calls>
        <invoke name="web_search">
        <parameter name="query">what is Kortix AI and what are they building?</parameter>
        <parameter name="num_results">20</parameter>
        </invoke>
        </function_calls>
        
        <!-- Another search example -->
        <function_calls>
        <invoke name="web_search">
        <parameter name="query">latest AI research on transformer models</parameter>
        <parameter name="num_results">20</parameter>
        </invoke>
        </function_calls>
        ''')
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
            
            # Check if we have actual results or an answer
            results = search_response.get('results', [])
            answer = search_response.get('answer', '')
            
            # Return the complete Tavily response 
            # This includes the query, answer, results, images and more
            logging.info(f"Retrieved search results for query: '{query}' with answer and {len(results)} results")
            
            # Consider search successful if we have either results OR an answer
            if len(results) > 0 or (answer and answer.strip()):
                return ToolResult(
                    success=True,
                    output=json.dumps(search_response, ensure_ascii=False)
                )
            else:
                # No results or answer found
                logging.warning(f"No search results or answer found for query: '{query}'")
                return ToolResult(
                    success=False,
                    output=json.dumps(search_response, ensure_ascii=False)
                )
        
        except Exception as e:
            error_message = str(e)
            logging.error(f"Error performing web search for '{query}': {error_message}")
            simplified_message = f"Error performing web search: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)

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
    @usage_example('''
        <function_calls>
        <invoke name="scrape_webpage">
        <parameter name="urls">https://www.kortix.ai/,https://github.com/kortix-ai/suna</parameter>
        </invoke>
        </function_calls>
        
        <!-- Example with HTML content included -->
        <function_calls>
        <invoke name="scrape_webpage">
        <parameter name="urls">https://example.com/complex-page</parameter>
        <parameter name="include_html">true</parameter>
        </invoke>
        </function_calls>
        ''')
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
            tasks = [self._scrape_single_url(url, include_html) for url in url_list]
            results = await asyncio.gather(*tasks, return_exceptions=True)

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

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "image_search",
            "description": "Search for images using SERPER API. Supports both single and batch searches. Returns image URLs for the given search query(s). Perfect for finding visual content, illustrations, photos, or any images related to your search terms.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "oneOf": [
                            {
                                "type": "string",
                                "description": "Single search query. Be specific about what kind of images you're looking for (e.g., 'cats playing', 'mountain landscape', 'modern architecture')"
                            },
                            {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Multiple search queries for batch processing. More efficient for multiple searches (e.g., ['cats', 'dogs', 'birds'])"
                            }
                        ],
                        "description": "Search query or queries. Single string for one search, array of strings for batch search."
                    },
                    "num_results": {
                        "type": "integer",
                        "description": "The number of image results to return per query. Default is 12, maximum is 100.",
                        "default": 12,
                        "minimum": 1,
                        "maximum": 100
                    }
                },
                "required": ["query"]
            }
        }
    })
    @usage_example('''
        <!-- Single search -->
        <function_calls>
        <invoke name="image_search">
        <parameter name="query">cute cats playing</parameter>
        <parameter name="num_results">20</parameter>
        </invoke>
        </function_calls>
        
        <!-- Batch search (more efficient for multiple queries) -->
        <function_calls>
        <invoke name="image_search">
        <parameter name="query">["cats", "dogs", "birds"]</parameter>
        <parameter name="num_results">15</parameter>
        </invoke>
        </function_calls>
        ''')
    async def image_search(
        self, 
        query: Union[str, List[str]],
        num_results: int = 12
    ) -> ToolResult:
        """
        Search for images using SERPER API and return image URLs.
        
        Supports both single and batch searches:
        - Single: query="cats" returns {"images": [...]}  
        - Batch: query=["cats", "dogs"] returns {"batch_results": [...]}
        """
        # Initialize variables for error handling
        is_batch = False
        queries = []
        
        try:
            # Validate inputs
            if isinstance(query, str):
                if not query or not query.strip():
                    return self.fail_response("A valid search query is required.")
                is_batch = False
                queries = [query]
            elif isinstance(query, list):
                if not query or not all(isinstance(q, str) and q.strip() for q in query):
                    return self.fail_response("All queries must be valid non-empty strings.")
                is_batch = True
                queries = query
            else:
                return self.fail_response("Query must be either a string or list of strings.")
            
            # Check if SERPER API key is available
            if not self.serper_api_key:
                return self.fail_response("SERPER_API_KEY not configured. Image search is not available.")
            
            # Normalize num_results
            if num_results is None:
                num_results = 12
            elif isinstance(num_results, str):
                try:
                    num_results = int(num_results)
                except ValueError:
                    num_results = 12
            
            # Clamp num_results to valid range
            num_results = max(1, min(num_results, 100))

            if is_batch:
                logging.info(f"Executing batch image search for {len(queries)} queries with {num_results} results each")
                # Batch API request
                payload = [{"q": q, "num": num_results} for q in queries]
            else:
                logging.info(f"Executing image search for query: '{queries[0]}' with {num_results} results")
                # Single API request  
                payload = {"q": queries[0], "num": num_results}
            
            # SERPER API request
            async with httpx.AsyncClient() as client:
                headers = {
                    "X-API-KEY": self.serper_api_key,
                    "Content-Type": "application/json"
                }
                
                response = await client.post(
                    "https://google.serper.dev/images",
                    json=payload,
                    headers=headers,
                    timeout=30.0
                )
                
                response.raise_for_status()
                data = response.json()
                
                if is_batch:
                    # Handle batch response
                    if not isinstance(data, list):
                        return self.fail_response("Unexpected batch response format from SERPER API.")
                    
                    batch_results = []
                    for i, (q, result_data) in enumerate(zip(queries, data)):
                        images = result_data.get("images", []) if isinstance(result_data, dict) else []
                        
                        # Extract image URLs
                        image_urls = []
                        for img in images:
                            img_url = img.get("imageUrl")
                            if img_url:
                                image_urls.append(img_url)
                        
                        batch_results.append({
                            "query": q,
                            "total_found": len(image_urls),
                            "images": image_urls
                        })
                        
                        logging.info(f"Found {len(image_urls)} image URLs for query: '{q}'")
                    
                    result = {
                        "batch_results": batch_results,
                        "total_queries": len(queries)
                    }
                else:
                    # Handle single response
                    images = data.get("images", [])
                    
                    if not images:
                        logging.warning(f"No images found for query: '{queries[0]}'")
                        return self.fail_response(f"No images found for query: '{queries[0]}'")
                    
                    # Extract just the image URLs - keep it simple
                    image_urls = []
                    for img in images:
                        img_url = img.get("imageUrl")
                        if img_url:
                            image_urls.append(img_url)
                    
                    logging.info(f"Found {len(image_urls)} image URLs for query: '{queries[0]}'")
                    
                    result = {
                        "query": queries[0],
                        "total_found": len(image_urls),
                        "images": image_urls
                    }
                
                return ToolResult(
                    success=True,
                    output=json.dumps(result, ensure_ascii=False)
                )
        
        except httpx.HTTPStatusError as e:
            error_message = f"SERPER API error: {e.response.status_code}"
            if e.response.status_code == 429:
                error_message = "SERPER API rate limit exceeded. Please try again later."
            elif e.response.status_code == 401:
                error_message = "Invalid SERPER API key."
            
            query_desc = f"batch queries {queries}" if is_batch else f"query '{queries[0]}'"
            logging.error(f"SERPER API error for {query_desc}: {error_message}")
            return self.fail_response(error_message)
        
        except Exception as e:
            error_message = str(e)
            query_desc = f"batch queries {queries}" if is_batch else f"query '{queries[0]}'"
            logging.error(f"Error performing image search for {query_desc}: {error_message}")
            simplified_message = f"Error performing image search: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)

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