from dotenv import load_dotenv
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.utils.config import config
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.services.http_client import get_http_client
import json
import logging
import asyncio
import base64
import replicate
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

**🚨 CRITICAL: USE BATCH MODE - ONE CALL, MULTIPLE QUERIES**
- **NEVER** make multiple separate image_search calls
- **ALWAYS** pass ALL your queries as an array in a SINGLE call
- This is FASTER (parallel execution) and costs FEWER TOKENS
- ❌ WRONG: 3 separate calls for "cats", "dogs", "birds"
- ✅ CORRECT: ONE call with query=["cats", "dogs", "birds"]

**CORE FUNCTIONALITY:**
- Search for images using SERPER API
- Retrieve relevant images related to search queries
- **BATCH SEARCHING:** Execute multiple image queries concurrently in ONE call
- Get comprehensive image results with titles, URLs, dimensions, and metadata
- **OCR EXTRACTION:** Automatically extracts text from images using vision AI

**RESPONSE DATA INCLUDES:**
- `imageUrl`: Direct URL to the full-size image
- `title`: Image title/description from source
- `width` & `height`: Image dimensions in pixels
- `source`: Source website name
- `link`: Link to the page containing the image
- `thumbnailUrl`: URL to a smaller preview image
- `description`: AI-generated description of the image (automatically included)

**BATCH MODE EXAMPLE:**
- Single call: image_search(query=["Tesla logo", "Tesla Model S", "Tesla factory"], num_results=5)
- All 3 queries execute in parallel - much faster than 3 separate calls!
- Returns: `{"batch_results": [{"query": "...", "images": [{...}, {...}]}, ...]}`

**OCR/VISION INCLUDED BY DEFAULT:**
- All image results include AI-generated descriptions automatically
- Note: Vision processing adds time as images must be downloaded and analyzed
- For faster responses, use lower `num_results` (3-5)

**BEST PRACTICES:**
- **BATCH ALL QUERIES** - collect all image needs, then make ONE call
- Use specific, descriptive queries for better results
- Include topic context in queries (e.g., "[topic name] [specific attribute]")
- Set `num_results` parameter to control how many images per query
- Review image URLs and select most appropriate for your needs
- Download images using shell commands (wget) before using them

**INTEGRATION WITH PRESENTATIONS:**
- Collect ALL image needs for the presentation first
- Make ONE batch call with all queries: ["Company logo", "Product photo", "Team image", etc.]
- Always include actual topic/brand/product name in queries
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
            from core.utils.logger import logger
            logger.warning("SERPER_API_KEY not configured - Image Search Tool will not be available")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "image_search",
            "description": "Search for images using SERPER API. Supports both single and batch searches. Returns detailed image data including URLs, dimensions (width/height), titles, metadata, and OCR-extracted text from each image. Perfect for finding visual content, illustrations, photos, or any images related to your search terms. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `query` (REQUIRED), `num_results` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "oneOf": [
                            {
                                "type": "string",
                                "description": "**REQUIRED** - Single search query. Be specific about what kind of images you're looking for. Example: 'cats playing', 'mountain landscape', 'modern architecture'"
                            },
                            {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "**REQUIRED** - Multiple search queries for batch processing. More efficient for multiple searches when you need to find images for several topics simultaneously. Example: ['cats', 'dogs', 'birds']"
                            }
                        ],
                        "description": "**REQUIRED** - Search query or queries. Single string for one search, array of strings for batch search."
                    },
                    "num_results": {
                        "type": "integer",
                        "description": "**OPTIONAL** - The number of image results to return per query. Default: 12. Maximum: 100. Minimum: 1.",
                        "default": 12,
                        "minimum": 1,
                        "maximum": 100
                    }
                },
                "required": ["query"],
                "additionalProperties": False
            }
        }
    })
    async def image_search(
        self, 
        query: Union[str, List[str]],
        num_results: int = 12
    ) -> ToolResult:
        """
        Search for images using SERPER API and return detailed image data.
        
        Supports both single and batch searches.
        Returns image URLs, dimensions (width/height), titles, and OCR-extracted text.
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
                logging.info(f"Executing batch image search for {len(queries)} queries with {num_results} results each (OCR enabled)")
                # Batch API request
                payload = [{"q": q, "num": num_results} for q in queries]
            else:
                logging.info(f"Executing image search for query: '{queries[0]}' with {num_results} results (OCR enabled)")
                # Single API request  
                payload = {"q": queries[0], "num": num_results}
            
            # SERPER API request
            async with get_http_client() as client:
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
                
                # Log raw response structure for debugging
                # logging.info(f"[ImageSearch] Raw SERPER response structure: {json.dumps(data if not is_batch else data[0] if data else {}, indent=2)[:1000]}")
                
                if is_batch:
                    # Handle batch response
                    if not isinstance(data, list):
                        return self.fail_response("Unexpected batch response format from SERPER API.")
                    
                    batch_results = []
                    for i, (q, result_data) in enumerate(zip(queries, data)):
                        images = result_data.get("images", []) if isinstance(result_data, dict) else []
                        
                        # Extract detailed image data with OCR
                        image_data_list = await self._extract_image_data(images, client)
                        
                        batch_results.append({
                            "query": q,
                            "total_found": len(image_data_list),
                            "images": image_data_list
                        })
                        
                        logging.info(f"Found {len(image_data_list)} images for query: '{q}'")
                    
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
                    
                    # Extract detailed image data with OCR
                    image_data_list = await self._extract_image_data(images, client)
                    
                    logging.info(f"Found {len(image_data_list)} images for query: '{queries[0]}'")
                    
                    result = {
                        "query": queries[0],
                        "total_found": len(image_data_list),
                        "images": image_data_list
                    }
                
                return ToolResult(
                    success=True,
                    output=json.dumps(result, ensure_ascii=False)
                )
        
        except Exception as e:
            if hasattr(e, 'response') and hasattr(e.response, 'status_code'):
                # HTTPStatusError handling
                error_message = f"SERPER API error: {e.response.status_code}"
                if e.response.status_code == 429:
                    error_message = "SERPER API rate limit exceeded. Please try again later."
                elif e.response.status_code == 401:
                    error_message = "Invalid SERPER API key."
                
                query_desc = f"batch queries {queries}" if is_batch else f"query '{queries[0] if queries else 'unknown'}'"
                logging.error(f"SERPER API error for {query_desc}: {error_message}")
                return self.fail_response(error_message)
            else:
                error_message = str(e)
                query_desc = f"batch queries {queries}" if is_batch else f"query '{queries[0] if queries else 'unknown'}'"
                logging.error(f"Error performing image search for {query_desc}: {error_message}")
                simplified_message = f"Error performing image search: {error_message[:200]}"
                if len(error_message) > 200:
                    simplified_message += "..."
                return self.fail_response(simplified_message)

    async def _extract_image_data(self, images: List[dict], http_client) -> List[dict]:
        """
        Extract detailed image data from SERPER API response.
        Performs OCR on all images IN PARALLEL for speed.
        
        Args:
            images: List of image objects from SERPER API
            http_client: HTTP client for downloading images
            
        Returns:
            List of image data dictionaries with url, dimensions, title, and OCR text
        """
        # First, collect all valid images with their metadata
        valid_images = []
        for img in images:
            img_url = img.get("imageUrl")
            if not img_url:
                continue
            
            # Extract all available metadata from SERPER response
            image_data = {
                "imageUrl": img_url,
                "title": img.get("title", ""),
                "width": img.get("imageWidth") or img.get("width", 0),
                "height": img.get("imageHeight") or img.get("height", 0),
                "source": img.get("source", ""),
                "link": img.get("link", ""),
                "thumbnailUrl": img.get("thumbnailUrl", ""),
                "domain": img.get("domain", ""),
                "description": ""  # Will be filled by parallel OCR
            }
            
            logging.debug(f"[ImageSearch] Raw image metadata: {json.dumps(img, indent=2)[:500]}")
            valid_images.append((img_url, image_data))
        
        if not valid_images:
            return []
        
        # Run all image descriptions in parallel using Moondream2
        logging.info(f"[ImageSearch] Starting parallel Moondream2 for {len(valid_images)} images")
        desc_tasks = [self._describe_image(img_url, http_client) for img_url, _ in valid_images]
        desc_results = await asyncio.gather(*desc_tasks, return_exceptions=True)
        
        # Combine results
        image_data_list = []
        for i, (img_url, image_data) in enumerate(valid_images):
            desc_result = desc_results[i]
            if isinstance(desc_result, Exception):
                logging.warning(f"[ImageSearch] Description failed for image {i}: {desc_result}")
                image_data["description"] = ""
            else:
                image_data["description"] = desc_result or ""
            image_data_list.append(image_data)
        
        logging.info(f"[ImageSearch] Completed parallel Moondream2 for {len(image_data_list)} images")
        return image_data_list
    
    async def _describe_image(self, image_url: str, http_client) -> str:
        """
        Download an image and get a description using Moondream2 vision model.
        Runs in parallel with other image descriptions via asyncio.gather.
        
        Args:
            image_url: URL of the image to process
            http_client: HTTP client for downloading
            
        Returns:
            Image description, or empty string if processing fails
        """
        try:
            # Download the image
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
            
            response = await http_client.get(image_url, headers=headers, timeout=10.0, follow_redirects=True)
            
            if response.status_code != 200:
                logging.debug(f"[ImageSearch] Failed to download image: {response.status_code}")
                return ""
            
            image_bytes = response.content
            
            # Check content type
            content_type = response.headers.get("content-type", "")
            if not content_type.startswith("image/"):
                logging.debug(f"[ImageSearch] Non-image content type: {content_type}")
                return ""
            
            # Convert to base64 data URL for Replicate
            image_b64 = base64.b64encode(image_bytes).decode("utf-8")
            data_url = f"data:{content_type};base64,{image_b64}"
            
            logging.debug(f"[ImageSearch] Running Moondream2 on image ({len(image_bytes)} bytes)")
            
            # Call Moondream2 vision model - runs in thread pool
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
            
            logging.debug(f"[ImageSearch] Got description: {len(description)} chars")
            return description.strip()
                
        except Exception as e:
            logging.debug(f"[ImageSearch] Error processing image {image_url[:50]}...: {str(e)[:100]}")
            return ""
