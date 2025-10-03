from chunkr_ai import Chunkr
from typing import Dict, Any

from core.agentpress.tool import ToolResult, openapi_schema
from core.agentpress.thread_manager import ThreadManager
from core.sandbox.tool_base import SandboxToolsBase
from core.utils.logger import logger


class SandboxDocumentParserTool(SandboxToolsBase):
    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.chunkr = Chunkr()

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "parse_document",
            "description": "Parse any document type from a URL and extract text, metadata, tables, and structured data. Auto-detects format from URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "URL to the document file to parse (must start with http:// or https://)"
                    },
                    "extract_tables": {
                        "type": "boolean",
                        "description": "Whether to extract tables from the document",
                        "default": False
                    },
                    "extract_structured_data": {
                        "type": "boolean",
                        "description": "Whether to extract structured data like forms, key-value pairs, etc.",
                        "default": False
                    }
                },
                "required": ["url"]
            }
        }
    })
    async def parse_document(
        self, 
        url: str, 
        extract_tables: bool = False, 
        extract_structured_data: bool = False,
        options: Dict[str, Any] = None
    ) -> ToolResult:
        try:
            await self._ensure_sandbox()
            
            if options is None:
                options = {}
            
            # Validate that the input is a URL
            if not url.startswith(('http://', 'https://')):
                return self.fail_response(f"Invalid URL: {url}. URL must start with http:// or https://")
            
            logger.info(f"Parsing document from URL: {url}")
            
            logger.debug(f"Uploading to Chunkr AI: {url}")
            
            # Upload to Chunkr and get the task result
            task = await self.chunkr.upload(url)
            
            logger.debug(f"Chunkr task completed successfully")
            
            # Extract meaningful content from the Chunkr response
            parsed_content = self._extract_meaningful_content(task, extract_tables, extract_structured_data)
            
            return self.success_response({
                "message": f"Successfully parsed document from URL: {url}",
                "content": parsed_content
            })
            
        except Exception as e:
            logger.error(f"Error parsing document from URL {url}: {e}", exc_info=True)
            return self.fail_response(f"Error parsing document from URL: {str(e)}")
    
    def _extract_meaningful_content(self, task, extract_tables: bool, extract_structured_data: bool) -> Dict[str, Any]:
        """Extract meaningful content from Chunkr task response without overwhelming detail."""
        try:
            content = {
                "document_info": {},
                "text_content": [],
                "structure": [],
                "tables": [],
                "metadata": {}
            }
            
            # Check if task has output
            if not hasattr(task, 'output') or not task.output:
                return {"error": "No content found in document"}
            
            output = task.output
            
            # Extract basic document info
            content["document_info"] = {
                "total_chunks": len(output.chunks) if hasattr(output, 'chunks') else 0,
                "status": "completed",
                "processing_time": str(getattr(task, 'finished_at', 'N/A'))
            }
            
            # Process chunks to extract text and structure
            if hasattr(output, 'chunks') and output.chunks:
                for chunk in output.chunks:
                    if hasattr(chunk, 'segments'):
                        for segment in chunk.segments:
                            segment_info = {
                                "type": str(getattr(segment, 'segment_type', 'unknown')),
                                "content": getattr(segment, 'content', ''),
                                "page": getattr(segment, 'page_number', 1)
                            }
                            
                            # Clean up content (remove excessive dots and formatting artifacts)
                            clean_content = self._clean_content(segment_info["content"])
                            
                            if clean_content and len(clean_content.strip()) > 3:  # Skip very short/empty content
                                segment_info["content"] = clean_content
                                
                                # Categorize by segment type
                                seg_type = segment_info["type"].lower()
                                
                                if 'title' in seg_type:
                                    content["structure"].append({
                                        "type": "heading",
                                        "content": clean_content,
                                        "page": segment_info["page"]
                                    })
                                elif 'table' in seg_type and extract_tables:
                                    # Extract table data if available
                                    table_data = {
                                        "content": clean_content,
                                        "page": segment_info["page"]
                                    }
                                    if hasattr(segment, 'html') and segment.html:
                                        table_data["html"] = segment.html
                                    content["tables"].append(table_data)
                                elif 'text' in seg_type:
                                    content["text_content"].append({
                                        "text": clean_content,
                                        "page": segment_info["page"]
                                    })
            
            # Summarize content for easier consumption
            content["summary"] = self._create_content_summary(content)
            
            return content
            
        except Exception as e:
            logger.error(f"Error extracting content from Chunkr response: {e}", exc_info=True)
            return {"error": f"Failed to extract content: {str(e)}"}
    
    def _clean_content(self, content: str) -> str:
        """Clean up content by removing excessive formatting artifacts."""
        if not content:
            return ""
        
        # Remove excessive dots (common in TOC entries)
        content = content.strip()
        
        # Skip content that's mostly dots
        if content.count('.') > len(content) * 0.5:
            return ""
        
        # Remove standalone dots and clean up spacing
        if content in ['.', '..', '...'] or len(content.strip('.').strip()) == 0:
            return ""
        
        return content
    
    def _create_content_summary(self, content: Dict[str, Any]) -> Dict[str, Any]:
        """Create a summary of the extracted content."""
        return {
            "total_pages": max([item.get("page", 1) for item in content["text_content"]] + [1]),
            "headings_count": len(content["structure"]),
            "text_sections": len(content["text_content"]),
            "tables_count": len(content["tables"]),
            "main_headings": [item["content"] for item in content["structure"][:5]]  # First 5 headings
        }