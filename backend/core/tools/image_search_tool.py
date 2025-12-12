import httpx
from dotenv import load_dotenv
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.utils.config import config
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
import json
import logging
from typing import Union, List

@tool_metadata(
    display_name="Image Search",
    description="Find images on the internet for any topic or subject",
    icon="ImageSearch",
    color="bg-fuchsia-100 dark:bg-fuchsia-800/50",
    weight=130,
    visible=True,
    usage_guide="""
### IMAGE SEARCH CAPABILITIES

**CORE FUNCTIONALITY:**
- Search for images using SERPER API
- Retrieve relevant images related to search queries
- **BATCH SEARCHING:** Execute multiple image queries concurrently
- Get comprehensive image results with titles, URLs, and metadata

**BATCH MODE FOR EFFICIENCY:**
- Use `image_search(query=["query1", "query2", "query3"])` for multiple searches
- All queries execute in parallel for faster results
- Returns: `{"batch_results": [{"query": "...", "images": ["url1", "url2"]}, ...]}`

**BEST PRACTICES:**
- Use specific, descriptive queries for better results
- Include topic context in queries (e.g., "[topic name] [specific attribute]")
- Set `num_results` parameter to control how many images per query
- Review image URLs and select most appropriate for your needs
- Download images using shell commands (wget) before using them

**INTEGRATION WITH PRESENTATIONS:**
- Search for topic-specific images (not generic)
- Always include actual topic/brand/product name in queries
- Use batch mode to search for all needed images at once
- Download all images in a single chained command
"""
)
class SandboxImageSearchTool(SandboxToolsBase):
    """Tool for performing image searches using SERPER API."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        # Load environment variables
        load_dotenv()
        # Use API keys from config
        self.serper_api_key = config.SERPER_API_KEY
        
        if not self.serper_api_key:
            logger.warning("SERPER_API_KEY not configured - Image Search Tool will not be available")

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
            # Check if Serper API key is configured
            if not self.serper_api_key:
                return self.fail_response("Image Search is not available. SERPER_API_KEY is not configured.")
            
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
