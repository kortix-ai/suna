from tavily import AsyncTavilyClient
import httpx
from dotenv import load_dotenv
from agentpress.tool import Tool, ToolResult, openapi_schema, xml_schema
from utils.config import config
import json
import logging

# TODO: add subpages, etc... in filters as sometimes its necessary 

class WebSearchTool(Tool):
    """Tool for performing web searches using Tavily API and web scraping using Firecrawl."""

    def __init__(self, api_key: str = None):
        super().__init__()
        # Load environment variables
        load_dotenv()
        # Use the provided API key or get it from environment variables
        self.tavily_api_key = api_key or config.TAVILY_API_KEY
        self.firecrawl_api_key = config.FIRECRAWL_API_KEY
        self.firecrawl_url = config.FIRECRAWL_URL
        self.scrapegraphai_api_key = config.SCRAPEGRAPHAI_API_KEY
        self.scrapegraphai_url = config.SCRAPEGRAPHAI_URL
        
        if not self.tavily_api_key:
            raise ValueError("TAVILY_API_KEY not found in configuration")
        if not self.firecrawl_api_key and not self.scrapegraphai_api_key:
            raise ValueError("Neither FIRECRAWL_API_KEY nor SCRAPEGRAPHAI_API_KEY found in configuration")

        # Tavily asynchronous search client
        self.tavily_client = AsyncTavilyClient(api_key=self.tavily_api_key)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for up-to-date information on a specific topic using the Tavily API. This tool allows you to gather real-time information from the internet to answer user queries, research topics, validate facts, and find recent developments. Results include titles, URLs, summaries, and publication dates. Use this tool for discovering relevant web pages before potentially crawling them for complete content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query to find relevant web pages. Be specific and include key terms to improve search accuracy. For best results, use natural language questions or keyword combinations that precisely describe what you're looking for."
                    },
                    # "summary": {
                    #     "type": "boolean",
                    #     "description": "Whether to include a summary of each search result. Summaries provide key context about each page without requiring full content extraction. Set to true to get concise descriptions of each result.",
                    #     "default": True
                    # },
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
            # {"param_name": "summary", "node_type": "attribute", "path": "."},
            {"param_name": "num_results", "node_type": "attribute", "path": "."}
        ],
        example='''
        <!-- 
        The web-search tool allows you to search the internet for real-time information.
        Use this tool when you need to find current information, research topics, or verify facts.
        
        The tool returns information including:
        - Titles of relevant web pages
        - URLs for accessing the pages
        - Published dates (when available)
        -->
        
        <!-- Simple search example -->
        <web-search 
            query="current weather in New York City" 
            num_results="20">
        </web-search>
        
        <!-- Another search example -->
        <web-search 
            query="healthy breakfast recipes" 
            num_results="20">
        </web-search>
        '''
    )
    async def web_search(
        self, 
        query: str, 
        # summary: bool = True,
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
            search_response = await self.tavily_client.search(
                query=query,
                max_results=num_results,
                include_answer=False,
                include_images=False,
            )

            # Normalize the response format
            raw_results = (
                search_response.get("results")
                if isinstance(search_response, dict)
                else search_response
            )

            # Format results consistently
            formatted_results = []
            for result in raw_results:
                formatted_result = {
                    "title": result.get("title", ""),
                    "url": result.get("url", ""),
                }

                # if summary:
                #     # Prefer full content; fall back to description
                #     formatted_result["snippet"] = (
                #         result.get("content") or 
                #         result.get("description") or 
                #         ""
                #     )

                formatted_results.append(formatted_result)
            
            # Return a properly formatted ToolResult
            return ToolResult(
                success=True,
                output=json.dumps(formatted_results, ensure_ascii=False)
            )
        
        except Exception as e:
            error_message = str(e)
            simplified_message = f"Error performing web search: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "scrape_webpage",
            "description": "Retrieve the complete text content of a specific webpage using ScrapeGraphAI or Firecrawl. This tool extracts the full text content from any accessible web page and returns it for analysis, processing, or reference. The extracted text includes the main content of the page without HTML markup. Note that some pages may have limitations on access due to paywalls, access restrictions, or dynamic content loading.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The complete URL of the webpage to scrape. This should be a valid, accessible web address including the protocol (http:// or https://). The tool will attempt to extract all text content from this URL."
                    }
                },
                "required": ["url"]
            }
        }
    })
    @xml_schema(
        tag_name="scrape-webpage",
        mappings=[
            {"param_name": "url", "node_type": "attribute", "path": "."}
        ],
        example='''
        <!-- 
        The scrape-webpage tool extracts the complete text content from web pages using ScrapeGraphAI or Firecrawl.
        IMPORTANT WORKFLOW RULES:
        1. ALWAYS use web-search first to find relevant URLs
        2. Then use scrape-webpage on URLs from web-search results
        3. Only if scrape-webpage fails or if the page requires interaction:
           - Use direct browser tools (browser_navigate_to, browser_click_element, etc.)
           - This is needed for dynamic content, JavaScript-heavy sites, or pages requiring interaction
        
        ScrapeGraphAI Features:
        - Handles dynamic content and JavaScript-rendered sites
        - Manages proxies, caching, and rate limits
        - Supports PDFs and images
        - Outputs clean markdown
        
        Firecrawl Features:
        - Converts web pages into clean markdown
        - Handles dynamic content and JavaScript-rendered sites
        - Manages proxies, caching, and rate limits
        - Supports PDFs and images
        - Outputs clean markdown
        -->
        
        <!-- Example workflow: -->
        <!-- 1. First search for relevant content -->
        <web-search 
            query="latest AI research papers" 
            # summary="true"
            num_results="5">
        </web-search>
        
        <!-- 2. Then scrape specific URLs from search results -->
        <scrape-webpage 
            url="https://example.com/research/ai-paper-2024">
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
        url: str
    ) -> ToolResult:
        """
        Retrieve the complete text content of a webpage using ScrapeGraphAI or Firecrawl.
        
        This function first attempts to use ScrapeGraphAI if available, then falls back to Firecrawl.
        The extracted text is returned in the response, making it available for further analysis,
        processing, or reference.
        
        The returned data includes:
        - Title: The title of the webpage
        - URL: The URL of the scraped page
        - Published Date: When the content was published (if available)
        - Text: The complete text content of the webpage in markdown format
        
        Note that some pages may have limitations on access due to paywalls, 
        access restrictions, or dynamic content loading.
        
        Parameters:
        - url: The URL of the webpage to scrape
        """
        try:
            # Parse the URL parameter exactly as it would appear in XML
            if not url:
                return self.fail_response("A valid URL is required.")
                
            # Handle url parameter (as it would appear in XML)
            if isinstance(url, str):
                # Add protocol if missing
                if not (url.startswith('http://') or url.startswith('https://')):
                    url = 'https://' + url
            else:
                return self.fail_response("URL must be a string.")

            # Try ScrapeGraphAI first if API key is available
            if self.scrapegraphai_api_key:
                try:
                    async with httpx.AsyncClient() as client:
                        headers = {
                            "Content-Type": "application/json",
                            "SGAI-APIKEY": self.scrapegraphai_api_key,
                            "accept": "application/json"
                        }
                        payload = {
                            "website_url": url
                        }
                        response = await client.post(
                            self.scrapegraphai_url,
                            json=payload,
                            headers=headers,
                            timeout=60
                        )
                        response.raise_for_status()
                        data = response.json()

                        # Format the response from ScrapeGraphAI
                        formatted_result = {
                            "Title": data.get("title", ""),
                            "URL": url,
                            "Text": data.get("result", ""),
                            "RequestID": data.get("request_id", ""),
                            "Status": data.get("status", "")
                        }
                        
                        # Add metadata if available
                        if "metadata" in data:
                            formatted_result["Metadata"] = data["metadata"]
                        
                        return self.success_response([formatted_result])
                except Exception as e:
                    # If ScrapeGraphAI fails, log the error and continue to Firecrawl
                    logger.warning(f"ScrapeGraphAI failed: {str(e)}. Falling back to Firecrawl.")

            # Fall back to Firecrawl if ScrapeGraphAI is not available or failed
            if self.firecrawl_api_key:
                async with httpx.AsyncClient() as client:
                    headers = {
                        "Authorization": f"Bearer {self.firecrawl_api_key}",
                        "Content-Type": "application/json",
                    }
                    payload = {
                        "url": url,
                        "formats": ["markdown"]
                    }
                    response = await client.post(
                        f"{self.firecrawl_url}/v1/scrape",
                        json=payload,
                        headers=headers,
                        timeout=60,
                    )
                    response.raise_for_status()
                    data = response.json()

                # Format the response
                formatted_result = {
                    "Title": data.get("data", {}).get("metadata", {}).get("title", ""),
                    "URL": url,
                    "Text": data.get("data", {}).get("markdown", "")
                }
                
                # Add metadata if available
                if "metadata" in data.get("data", {}):
                    formatted_result["Metadata"] = data["data"]["metadata"]
                
                return self.success_response([formatted_result])
            else:
                return self.fail_response("No scraping service available (neither ScrapeGraphAI nor Firecrawl)")
        
        except Exception as e:
            error_message = str(e)
            # Truncate very long error messages
            simplified_message = f"Error scraping webpage: {error_message[:200]}"
            if len(error_message) > 200:
                simplified_message += "..."
            return self.fail_response(simplified_message)


if __name__ == "__main__":
    import asyncio
    
    async def test_web_search():
        """Test function for the web search tool"""
        search_tool = WebSearchTool()
        result = await search_tool.web_search(
            query="rubber gym mats best prices comparison",
            # summary=True,
            num_results=20
        )
        print(result)
    
    async def test_scrape_webpage():
        """Test function for the webpage scrape tool"""
        search_tool = WebSearchTool()
        result = await search_tool.scrape_webpage(
            url="https://www.wired.com/story/anthropic-benevolent-artificial-intelligence/"
        )
        print(result)
    
    async def run_tests():
        """Run all test functions"""
        await test_web_search()
        await test_scrape_webpage()
        
    asyncio.run(run_tests())