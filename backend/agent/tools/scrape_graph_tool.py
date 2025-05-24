from agentpress.tool import Tool, ToolResult, openapi_schema, xml_schema
from utils.config import config
from sandbox.tool_base import SandboxToolsBase
from agentpress.thread_manager import ThreadManager
import httpx
import json
import logging
import datetime
import asyncio
from urllib.parse import urlparse
from dotenv import load_dotenv

class ScrapeGraphTool(SandboxToolsBase):
    """Tool for performing web scraping using ScrapeGraphAI."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        # Load environment variables
        load_dotenv()
        # Use API key from config
        self.scrapegraphai_api_key = config.SCRAPEGRAPHAI_API_KEY
        self.scrapegraphai_url = config.SCRAPEGRAPHAI_URL
        
        if not self.scrapegraphai_api_key:
            raise ValueError("SCRAPEGRAPHAI_API_KEY not found in configuration")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "scrape_graph",
            "description": "Extract full text content from multiple webpages using ScrapeGraphAI. This tool provides efficient parallel scraping with proxy rotation and better handling of dynamic content. IMPORTANT: Always collect multiple relevant URLs and scrape them all in a single call for efficiency.",
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
        tag_name="scrape-graph",
        mappings=[
            {"param_name": "urls", "node_type": "attribute", "path": "."}
        ],
        example='''
        <!-- 
        The scrape-graph tool uses ScrapeGraphAI to efficiently extract content from multiple webpages.
        
        WORKFLOW PRIORITY:
        1. Use web-search first to find relevant URLs
        2. Then use scrape-graph to extract content from multiple URLs at once
        3. Only use browser tools if dynamic interaction is needed
        
        Features:
        - Parallel processing of multiple URLs
        - Proxy rotation for better reliability
        - Handles dynamic content and JavaScript
        - Supports PDFs and images
        - Outputs clean markdown
        -->
        
        <!-- Example: Scrape multiple URLs from search results -->
        <scrape-graph 
            urls="https://www.kortix.ai/,https://github.com/kortix-ai/suna">
        </scrape-graph>
        '''
    )
    async def scrape_graph(
        self,
        urls: str
    ) -> ToolResult:
        """
        Extract content from multiple webpages using ScrapeGraphAI.
        
        Parameters:
        - urls: Multiple URLs to scrape, separated by commas
        """
        try:
            logging.info(f"Starting ScrapeGraphAI scraping for URLs: {urls}")
            
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
            
            logging.info(f"Processing {len(url_list)} URLs with ScrapeGraphAI")
            
            # Process each URL and collect results
            results = []
            for url in url_list:
                try:
                    # Add protocol if missing
                    if not (url.startswith('http://') or url.startswith('https://')):
                        url = 'https://' + url
                        logging.info(f"Added https:// protocol to URL: {url}")
                    
                    # Scrape this URL using ScrapeGraphAI
                    result = await self._scrape_single_url(url)
                    results.append(result)
                    
                except Exception as e:
                    logging.error(f"Error processing URL {url}: {str(e)}")
                    results.append({
                        "url": url,
                        "success": False,
                        "error": str(e)
                    })
            
            # Summarize results
            successful = sum(1 for r in results if r.get("success", False))
            failed = len(results) - successful
            
            # Create success/failure message
            if successful == len(results):
                message = f"Successfully scraped all {len(results)} URLs using ScrapeGraphAI. Results saved to:"
                for r in results:
                    if r.get("file_path"):
                        message += f"\n- {r.get('file_path')}"
            elif successful > 0:
                message = f"Scraped {successful} URLs successfully and {failed} failed using ScrapeGraphAI. Results saved to:"
                for r in results:
                    if r.get("success", False) and r.get("file_path"):
                        message += f"\n- {r.get('file_path')}"
                message += "\n\nFailed URLs:"
                for r in results:
                    if not r.get("success", False):
                        message += f"\n- {r.get('url')}: {r.get('error', 'Unknown error')}"
            else:
                error_details = "; ".join([f"{r.get('url')}: {r.get('error', 'Unknown error')}" for r in results])
                return self.fail_response(f"Failed to scrape all {len(results)} URLs using ScrapeGraphAI. Errors: {error_details}")
            
            return ToolResult(
                success=True,
                output=message
            )
        
        except Exception as e:
            error_message = str(e)
            logging.error(f"Error in scrape_graph: {error_message}")
            return self.fail_response(f"Error processing scrape request: {error_message[:200]}")
    
    async def _scrape_single_url(self, url: str) -> dict:
        """
        Helper function to scrape a single URL using ScrapeGraphAI and return the result information.
        """
        logging.info(f"Scraping single URL with ScrapeGraphAI: {url}")
        
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
                
                # Use longer timeout and retry logic for more reliability
                max_retries = 3
                timeout_seconds = 120
                retry_count = 0
                
                while retry_count < max_retries:
                    try:
                        logging.info(f"Sending request to ScrapeGraphAI (attempt {retry_count + 1}/{max_retries})")
                        response = await client.post(
                            self.scrapegraphai_url,
                            json=payload,
                            headers=headers,
                            timeout=timeout_seconds
                        )
                        response.raise_for_status()
                        data = response.json()
                        logging.info(f"Successfully received response from ScrapeGraphAI for {url}")
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
            title = data.get("title", "")
            content = data.get("result", "")
            logging.info(f"Extracted content from {url}: title='{title}', content length={len(content)}")
            
            formatted_result = {
                "title": title,
                "url": url,
                "text": content,
                "request_id": data.get("request_id", ""),
                "status": data.get("status", "")
            }
            
            # Add metadata if available
            if "metadata" in data:
                formatted_result["metadata"] = data["metadata"]
                logging.info(f"Added metadata: {data['metadata'].keys()}")
            
            # Create a simple filename from the URL domain and date
            timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            
            # Extract domain from URL for the filename
            parsed_url = urlparse(url)
            domain = parsed_url.netloc.replace("www.", "")
            
            # Clean up domain for filename
            domain = "".join([c if c.isalnum() else "_" for c in domain])
            safe_filename = f"{timestamp}_{domain}_scrapegraph.json"
            
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
                "content_length": len(content)
            }
        
        except Exception as e:
            error_message = str(e)
            logging.error(f"Error scraping URL '{url}' with ScrapeGraphAI: {error_message}")
            
            # Create an error result
            return {
                "url": url,
                "success": False,
                "error": error_message
            }

if __name__ == "__main__":
    async def test_scrape_graph():
        """Test function for the ScrapeGraphAI tool"""
        # This test function is not compatible with the sandbox version
        print("Test function needs to be updated for sandbox version")
    
    async def run_tests():
        """Run all test functions"""
        await test_scrape_graph()
        
    asyncio.run(run_tests()) 