from tavily import AsyncTavilyClient
from dotenv import load_dotenv
from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.utils.config import config
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.services.http_client import get_http_client
import json
import datetime
import asyncio
import logging
import time
import base64
import replicate
import httpx

# TODO: add subpages, etc... in filters as sometimes its necessary 

@tool_metadata(
    display_name="WebSearch",
    description="Search the web and use the results to inform responses with up-to-date information",
    icon="Search",
    color="bg-green-100 dark:bg-green-800/50",
    weight=30,
    visible=True,
    usage_guide="""
## WebSearch - Search the web for current information

Allows searching the web and using the results to inform responses. Provides up-to-date information for current events and recent data.

### Available Tools
- **web_search**: Search the web with single or BATCH queries
- **scrape_webpage** (WebFetch): Extract full content from web pages

### When to Use
- Accessing information beyond the knowledge cutoff
- Finding current information, news, recent events
- Researching topics that require up-to-date data
- Gathering information from multiple sources
- Fact-checking or verifying claims

### When NOT to Use
- For information already in the conversation context
- When the user provides all necessary information
- For simple calculations or logic that doesn't need external data

### ⚠️ DO NOT OVERRIDE BROWSER-EXTRACTED DATA
- If you already visited a SPECIFIC website with browser_tool and extracted content from it, that extracted content is your **PRIMARY SOURCE**
- Web search results should NOT override or replace information you extracted directly from the target website
- Use web search only for ADDITIONAL context (reviews, news, competitor comparisons) - NOT to replace first-hand data
- Example: If user asks "create slides for magicterms.com" and you already browsed/extracted from magicterms.com, USE that extracted data - don't do web searches that might return info about OTHER similar websites

### CRITICAL REQUIREMENT - Sources

After answering the user's question, you MUST include a "Sources:" section at the end of your response listing all relevant URLs from the search results as markdown hyperlinks.

Example format:
```
[Your answer here]

Sources:
- [Source Title 1](https://example.com/1)
- [Source Title 2](https://example.com/2)
```

### Batch Mode

**ALWAYS batch multiple queries into ONE call for efficiency:**
- ❌ WRONG: 3 separate web_search calls
- ✅ CORRECT: ONE call with query=["topic 1", "topic 2", "topic 3"]

### Usage Pattern

```
# Correct - batch all queries
web_search(query=["Tesla news 2025", "Tesla stock", "Tesla products"], num_results=5)

# Wrong - never do this
web_search(query="Tesla news")
web_search(query="Tesla stock")  # Wasteful!
```

### Search Query Best Practice

IMPORTANT: Use the correct year in search queries. When searching for recent information, documentation, or current events, use the current year (2025+) rather than previous years.

### Content Extraction (WebFetch)

Use scrape_webpage to fetch and analyze web content:
- Fetches URL content and converts HTML to markdown
- Use a prompt to describe what information you want to extract
- For GitHub URLs, prefer using the gh CLI via Bash instead

### Important Notes
- query parameter: native array ["q1", "q2"], NOT JSON string
- num_results: integer (5), NOT string ("5")
- Check publication dates for time-sensitive info
- Cross-validate information across multiple sources
- Domain filtering is supported to include or block specific websites
"""
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
            "description": """Search the web for up-to-date information.

Allows searching the web and using the results to inform responses. Provides up-to-date information for current events and recent data. Returns search results including titles, URLs, publication dates, direct answers, and images.

CRITICAL REQUIREMENT - After answering the user's question, you MUST include a "Sources:" section listing all relevant URLs from the search results as markdown hyperlinks: [Title](URL)

Usage notes:
- Supports both single queries and batch queries (array) for concurrent execution
- Domain filtering is supported to include or block specific websites
- IMPORTANT: Use the current year in search queries when searching for recent information

IMPORTANT: For batch searches, pass query as a native array of strings, NOT as a JSON string.""",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "oneOf": [
                            {
                                "type": "string",
                                "description": "A single search query to find relevant web pages."
                            },
                            {
                                "type": "array",
                                "items": {
                                    "type": "string"
                                },
                                "description": "Multiple search queries to execute concurrently. Pass as a native array of strings, NOT as a JSON string."
                            }
                        ],
                        "description": "**REQUIRED** - The search query to use. Either a single query (string) or multiple queries (array) to execute concurrently."
                    },
                    "num_results": {
                        "type": "integer",
                        "description": "**OPTIONAL** - Number of search results to return per query (1-50). Default: 5.",
                        "default": 5
                    }
                },
                "required": ["query"],
                "additionalProperties": False
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

            if isinstance(query, str) and query.strip().startswith('['):
                try:
                    parsed_query = json.loads(query)
                    if isinstance(parsed_query, list):
                        query = parsed_query
                except (json.JSONDecodeError, ValueError):
                    pass
            
            is_batch = isinstance(query, list)
            
            if is_batch:
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
                    "elapsed_time": round(elapsed_time, 2),
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
                if not query or not isinstance(query, str):
                    return self.fail_response("A valid search query is required.")
                
                query = query.strip()
                if not query:
                    return self.fail_response("A valid search query is required.")
                
                logging.info(f"Executing web search for query: '{query}' with {num_results} results")
                start_time = time.time()
                result = await self._execute_single_search(query, num_results)
                elapsed_time = time.time() - start_time
                
                response = result.get("response", {})
                response["elapsed_time"] = round(elapsed_time, 2)
                
                if result.get("success", False):
                    return ToolResult(
                        success=True,
                        output=json.dumps(response, ensure_ascii=False)
                    )
                else:
                    logging.warning(f"No search results or answer found for query: '{query}'")
                    return ToolResult(
                        success=False,
                        output=json.dumps(response, ensure_ascii=False)
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
        - dict with success status, results, answer, images (with OCR & dimensions), and full response
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
            raw_images = search_response.get('images', [])
            
            # Enrich images with OCR and dimensions
            enriched_images = await self._enrich_images_with_metadata(raw_images)
            
            # Consider search successful if we have either results OR an answer
            success = len(results) > 0 or (answer and answer.strip())
            
            logging.info(f"Retrieved search results for query: '{query}' - {len(results)} results, answer: {'yes' if answer else 'no'}, {len(enriched_images)} images enriched")
            
            # Update search_response with enriched images
            enriched_response = dict(search_response)
            enriched_response['images'] = enriched_images
            
            return {
                "success": success,
                "results": results,
                "answer": answer,
                "images": enriched_images,
                "response": enriched_response
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

    async def _enrich_images_with_metadata(self, images: list) -> list:
        """
        Enrich image URLs with OCR text and dimensions.
        Downloads all images and runs OCR IN PARALLEL for speed.
        
        Args:
            images: List of image URLs (strings) or image objects from Tavily
            
        Returns:
            List of enriched image objects with url, width, height, and description
        """
        if not images:
            return []
        
        # Collect valid image URLs
        valid_images = []
        for img in images:
            if isinstance(img, str):
                img_url = img
            elif isinstance(img, dict):
                img_url = img.get('url', '')
            else:
                continue
            
            if img_url:
                valid_images.append(img_url)
        
        if not valid_images:
            return []
        
        logging.info(f"[WebSearch] Starting parallel image enrichment for {len(valid_images)} images")
        
        # Process all images in parallel
        async with get_http_client() as client:
            tasks = [self._enrich_single_image(img_url, client) for img_url in valid_images]
            results = await asyncio.gather(*tasks, return_exceptions=True)
        
        # Collect results, handling any exceptions
        enriched = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                logging.debug(f"[WebSearch] Error enriching image {i}: {result}")
                enriched.append({
                    "url": valid_images[i],
                    "width": 0,
                    "height": 0,
                    "description": ""
                })
            else:
                enriched.append(result)
        
        logging.info(f"[WebSearch] Completed parallel enrichment for {len(enriched)} images")
        return enriched
    
    async def _enrich_single_image(self, img_url: str, client) -> dict:
        """
        Download and enrich a single image with dimensions and description.
        Uses Moondream2 vision model for image understanding.
        
        Args:
            img_url: URL of the image
            client: HTTP client for downloading
            
        Returns:
            Enriched image data dict
        """
        image_data = {
            "url": img_url,
            "width": 0,
            "height": 0,
            "description": ""
        }
        
        try:
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
            
            response = await client.get(img_url, headers=headers, timeout=15.0, follow_redirects=True)
            
            if response.status_code == 200:
                image_bytes = response.content
                content_type = response.headers.get("content-type", "")
                
                if content_type.startswith("image/"):
                    # Get dimensions using PIL
                    try:
                        from PIL import Image
                        from io import BytesIO
                        img_pil = Image.open(BytesIO(image_bytes))
                        image_data["width"] = img_pil.width
                        image_data["height"] = img_pil.height
                        logging.debug(f"[WebSearch] Image dimensions: {img_pil.width}x{img_pil.height}")
                    except Exception as dim_err:
                        logging.debug(f"[WebSearch] Could not get dimensions: {dim_err}")
                    
                    # Get image description using Moondream2
                    description = await self._describe_image(image_bytes, content_type)
                    image_data["description"] = description
        
        except Exception as e:
            logging.debug(f"[WebSearch] Error enriching image {img_url[:50]}...: {str(e)[:100]}")
        
        return image_data
    
    async def _describe_image(self, image_bytes: bytes, content_type: str) -> str:
        """
        Get image description using Moondream2 vision model.
        Runs in ~2 seconds on Replicate GPU, includes text extraction.
        Skipped if REPLICATE_API_TOKEN is not configured.
        
        Args:
            image_bytes: Raw image bytes
            content_type: MIME type of the image
            
        Returns:
            Image description, or empty string if processing fails or token not configured
        """
        try:
            # Skip if Replicate token not configured
            from core.utils.config import get_config
            replicate_token = get_config().REPLICATE_API_TOKEN
            if not replicate_token:
                logging.debug("[WebSearch] Skipping Moondream2: REPLICATE_API_TOKEN not configured")
                return ""
            
            import os
            os.environ["REPLICATE_API_TOKEN"] = replicate_token
            
            logging.debug(f"[WebSearch] Running Moondream2 on image ({len(image_bytes)} bytes)")
            
            # Convert to base64 data URL
            image_b64 = base64.b64encode(image_bytes).decode("utf-8")
            data_url = f"data:{content_type};base64,{image_b64}"
            
            # Call Moondream2 vision model
            def run_moondream(data_url: str) -> str:
                output = replicate.run(
                    "lucataco/moondream2:72ccb656353c348c1385df54b237eeb7bfa874bf11486cf0b9473e691b662d31",
                    input={
                        "image": data_url,
                        "prompt": "Describe this image in detail. Include any text visible in the image."
                    }
                )
                # Output is a generator, consume it to get the full text
                if hasattr(output, '__iter__') and not isinstance(output, (str, bytes)):
                    return "".join(str(chunk) for chunk in output)
                return str(output) if output else ""
            
            description = await asyncio.to_thread(run_moondream, data_url)
            
            logging.debug(f"[WebSearch] Got description: {len(description)} chars")
            return description.strip()
            
        except Exception as e:
            logging.debug(f"[WebSearch] Moondream2 error: {e}")
            return ""

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "scrape_webpage",
            "description": """Fetches content from specified URLs and processes it.

Takes URLs as input, fetches the URL content, converts HTML to markdown, and returns the processed content. Use this tool when you need to retrieve and analyze web content.

Usage notes:
- IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead.
- The URLs must be fully-formed valid URLs.
- HTTP URLs will be automatically upgraded to HTTPS.
- Results may be summarized if the content is very large.
- For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view).
- Batch multiple URLs in a single call for efficiency.

IMPORTANT: You should ALWAYS collect multiple relevant URLs from web-search results and scrape them all in a single call for efficiency.""",
            "parameters": {
                "type": "object",
                "properties": {
                    "urls": {
                        "type": "string",
                        "description": "**REQUIRED** - URLs to scrape, separated by commas. Example: 'https://example.com/page1,https://example.com/page2'"
                    },
                    "include_html": {
                        "type": "boolean",
                        "description": "**OPTIONAL** - Whether to include the full raw HTML content alongside the extracted markdown. Default: false.",
                        "default": False
                    }
                },
                "required": ["urls"],
                "additionalProperties": False
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
            async with get_http_client() as client:
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