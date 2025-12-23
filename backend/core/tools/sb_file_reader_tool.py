import os
import shlex
import json
import asyncio
from typing import Optional, List
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.config import config
from core.utils.logger import logger

MAX_FILE_SIZE = 10 * 1024 * 1024
MAX_OUTPUT_CHARS = 50000
MAX_BATCH_SIZE = 20
KB_VERSION = "0.1.2"

@tool_metadata(
    display_name="File Reader",
    description="Read and search content from documents, PDFs, and text files",
    icon="FileText",
    color="bg-emerald-100 dark:bg-emerald-800/50",
    is_core=True,
    weight=35,
    visible=True,
    usage_guide="""
### FILE READING & SEARCH - USE search_file() BY DEFAULT!

**DEFAULT: Always use `search_file()` first!**
- `search_file(file_path="uploads/document.pdf", query="what is this about")`
- Returns relevant chunks without flooding context!

**SUPPORTED FILE TYPES:**
- PDF, Word (.doc, .docx), PowerPoint (.ppt, .pptx)
- Excel (.xls, .xlsx), CSV, JSON, XML
- Code files (py, js, ts, java, etc.)
- Text files (txt, md, log, etc.)

**Only use `read_file()` for:**
- Tiny config files (<2KB)
- When you need EXACT full content

**EXAMPLES:**
- PDF: `search_file(file_path="uploads/report.pdf", query="key findings")`
- Excel: `search_file(file_path="uploads/data.xlsx", query="sales summary")`
- PowerPoint: `search_file(file_path="uploads/deck.pptx", query="main slides")`
- Word: `search_file(file_path="uploads/doc.docx", query="contract terms")`
- Config: `read_file(file_path="uploads/config.json")` (tiny files only!)

**CRITICAL:**
- 95% of files → use `search_file()`
- Images → use `load_image()`
- ❌ NEVER use `read_file()` on large files!
"""
)
class SandboxFileReaderTool(SandboxToolsBase):
    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self._kb_ready = False

    async def _wait_for_uploads(self, timeout: int = 60) -> bool:
        from core.services import redis
        
        key = f"file_upload_pending:{self.project_id}"
        start_time = asyncio.get_event_loop().time()
        
        while True:
            pending = await redis.get(key)
            if pending is None:
                return True
            
            elapsed = asyncio.get_event_loop().time() - start_time
            if elapsed >= timeout:
                logger.warning(f"[FileReader] Timeout waiting for uploads to complete for project {self.project_id}")
                return False
            
            logger.debug(f"[FileReader] Waiting for {pending} file uploads to complete...")
            await asyncio.sleep(0.5)

    async def _ensure_kb(self) -> bool:
        if self._kb_ready:
            return True
        try:
            check = await self.sandbox.process.exec("kb -v 2>&1")
            if check.exit_code == 0 and f"kb-fusion {KB_VERSION}" in check.result:
                self._kb_ready = True
                return True
            
            url = f"https://github.com/kortix-ai/kb-fusion/releases/download/v{KB_VERSION}/kb"
            result = await self.sandbox.process.exec(
                f"curl -L -f {url} -o /tmp/kb && chmod +x /tmp/kb && mv /tmp/kb /usr/local/bin/kb"
            )
            self._kb_ready = result.exit_code == 0
            return self._kb_ready
        except Exception as e:
            logger.error(f"[SearchFile] kb install failed: {e}")
            return False

    def _get_file_type(self, file_path: str) -> str:
        ext = os.path.splitext(file_path)[1].lower()
        if ext == '.pdf':
            return 'pdf'
        elif ext == '.doc':
            return 'doc'
        elif ext == '.docx':
            return 'docx'
        elif ext == '.pptx':
            return 'pptx'
        elif ext == '.ppt':
            return 'ppt'
        elif ext == '.xlsx':
            return 'xlsx'
        elif ext == '.xls':
            return 'xls'
        elif ext in ['.txt', '.md', '.csv', '.json', '.xml', '.html', '.css', 
                     '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.hpp',
                     '.rb', '.go', '.rs', '.swift', '.kt', '.scala', '.php',
                     '.sh', '.bash', '.zsh', '.yaml', '.yml', '.toml', '.ini',
                     '.cfg', '.conf', '.log', '.sql', '.r', '.m', '.tex']:
            return 'text'
        return 'unknown'

    def _is_image_file(self, file_path: str) -> bool:
        ext = os.path.splitext(file_path)[1].lower()
        return ext in ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico']

    async def _read_single_file(self, file_path: str) -> dict:
        try:
            cleaned_path = self.clean_path(file_path)
            full_path = f"{self.workspace_path}/{cleaned_path}"

            if self._is_image_file(cleaned_path):
                return {
                    "file_path": cleaned_path,
                    "success": False,
                    "error": f"'{cleaned_path}' is an image file. Use load_image() instead of read_file() for images."
                }

            try:
                file_info = await self.sandbox.fs.get_file_info(full_path)
                if file_info.is_dir:
                    return {
                        "file_path": cleaned_path,
                        "success": False,
                        "error": f"Path '{cleaned_path}' is a directory, not a file."
                    }
            except Exception:
                return {
                    "file_path": cleaned_path,
                    "success": False,
                    "error": f"File not found: '{cleaned_path}'"
                }

            if file_info.size > MAX_FILE_SIZE:
                return {
                    "file_path": cleaned_path,
                    "success": False,
                    "error": f"File too large ({file_info.size / (1024*1024):.2f}MB). Max: {MAX_FILE_SIZE / (1024*1024)}MB."
                }

            file_type = self._get_file_type(cleaned_path)
            escaped_path = shlex.quote(full_path)
            content = ""
            extraction_method = "unknown"

            if file_type == 'pdf':
                result = await self.sandbox.process.exec(
                    f'pdftotext {escaped_path} - 2>/dev/null',
                    timeout=60
                )
                if result.exit_code != 0 or not result.result.strip():
                    result = await self.sandbox.process.exec(
                        f'pdftotext -layout {escaped_path} - 2>/dev/null',
                        timeout=60
                    )
                if result.exit_code != 0 or not result.result.strip():
                    result = await self.sandbox.process.exec(
                        f'python3 -c "import PyPDF2; r=PyPDF2.PdfReader({escaped_path!r}); print(\\"\\n\\".join(p.extract_text() or \\"\\" for p in r.pages))"',
                        timeout=60
                    )
                    extraction_method = "PyPDF2"
                else:
                    extraction_method = "pdftotext"
                
                if result.exit_code != 0:
                    return {
                        "file_path": cleaned_path,
                        "success": False,
                        "error": f"Failed to extract PDF text"
                    }
                content = result.result

            elif file_type == 'doc':
                result = await self.sandbox.process.exec(
                    f'catdoc {escaped_path} 2>/dev/null || antiword {escaped_path} 2>/dev/null',
                    timeout=60
                )
                if result.exit_code != 0:
                    return {
                        "file_path": cleaned_path,
                        "success": False,
                        "error": f"Failed to extract Word doc text"
                    }
                content = result.result
                extraction_method = "catdoc"

            elif file_type == 'docx':
                result = await self.sandbox.process.exec(
                    f"unzip -p {escaped_path} word/document.xml 2>/dev/null | sed -e 's/<[^>]*>//g' | tr -s ' \\n'",
                    timeout=60
                )
                if result.exit_code != 0 or not result.result.strip():
                    result = await self.sandbox.process.exec(
                        f'cat {escaped_path}',
                        timeout=60
                    )
                    extraction_method = "raw"
                else:
                    extraction_method = "unzip"
                content = result.result

            elif file_type == 'pptx':
                result = await self.sandbox.process.exec(
                    f"unzip -p {escaped_path} 'ppt/slides/*.xml' 2>/dev/null | sed -e 's/<[^>]*>//g' | tr -s ' \\n' | head -c 100000",
                    timeout=60
                )
                if result.exit_code != 0 or not result.result.strip():
                    result = await self.sandbox.process.exec(
                        f"python3 -c \"from pptx import Presentation; p=Presentation({escaped_path!r}); print('\\n'.join(shape.text for slide in p.slides for shape in slide.shapes if hasattr(shape, 'text')))\"",
                        timeout=60
                    )
                    extraction_method = "python-pptx"
                else:
                    extraction_method = "unzip"
                if result.exit_code != 0:
                    return {
                        "file_path": cleaned_path,
                        "success": False,
                        "error": "Failed to extract PowerPoint text. Try installing python-pptx."
                    }
                content = result.result

            elif file_type == 'ppt':
                result = await self.sandbox.process.exec(
                    f"catppt {escaped_path} 2>/dev/null",
                    timeout=60
                )
                if result.exit_code != 0:
                    return {
                        "file_path": cleaned_path,
                        "success": False,
                        "error": "Failed to extract old PowerPoint (.ppt). Convert to .pptx for better support."
                    }
                content = result.result
                extraction_method = "catppt"

            elif file_type == 'xlsx':
                result = await self.sandbox.process.exec(
                    f"python3 -c \"import openpyxl; wb=openpyxl.load_workbook({escaped_path!r}, data_only=True); [print(f'=== Sheet: {{ws.title}} ===') or [print('\\t'.join(str(c.value or '') for c in row)) for row in ws.iter_rows()] for ws in wb.worksheets]\" 2>/dev/null | head -c 100000",
                    timeout=60
                )
                if result.exit_code != 0 or not result.result.strip():
                    result = await self.sandbox.process.exec(
                        f"unzip -p {escaped_path} 'xl/sharedStrings.xml' 2>/dev/null | sed -e 's/<[^>]*>//g' | tr -s ' \\n' | head -c 100000",
                        timeout=60
                    )
                    extraction_method = "unzip"
                else:
                    extraction_method = "openpyxl"
                if result.exit_code != 0:
                    return {
                        "file_path": cleaned_path,
                        "success": False,
                        "error": "Failed to extract Excel text. Try installing openpyxl."
                    }
                content = result.result

            elif file_type == 'xls':
                result = await self.sandbox.process.exec(
                    f"python3 -c \"import xlrd; wb=xlrd.open_workbook({escaped_path!r}); [print(f'=== Sheet: {{ws.name}} ===') or [print('\\t'.join(str(ws.cell_value(r,c)) for c in range(ws.ncols))) for r in range(ws.nrows)] for ws in wb.sheets()]\" 2>/dev/null | head -c 100000",
                    timeout=60
                )
                if result.exit_code != 0:
                    result = await self.sandbox.process.exec(
                        f"xls2csv {escaped_path} 2>/dev/null | head -c 100000",
                        timeout=60
                    )
                    extraction_method = "xls2csv"
                else:
                    extraction_method = "xlrd"
                if result.exit_code != 0:
                    return {
                        "file_path": cleaned_path,
                        "success": False,
                        "error": "Failed to extract old Excel (.xls). Convert to .xlsx for better support."
                    }
                content = result.result

            else:
                result = await self.sandbox.process.exec(
                    f'cat {escaped_path}',
                    timeout=60
                )
                if result.exit_code != 0:
                    return {
                        "file_path": cleaned_path,
                        "success": False,
                        "error": f"Failed to read file"
                    }
                content = result.result
                extraction_method = "cat"

            truncated = False
            if len(content) > MAX_OUTPUT_CHARS:
                content = content[:MAX_OUTPUT_CHARS]
                truncated = True
                content += f"\n\n[Content truncated at {MAX_OUTPUT_CHARS} characters]"

            logger.info(f"[ReadFile] Read '{cleaned_path}' ({file_type}) via {extraction_method}, {len(content)} chars")

            return {
                "file_path": cleaned_path,
                "success": True,
                "file_type": file_type,
                "extraction_method": extraction_method,
                "size_bytes": file_info.size,
                "content_length": len(content),
                "truncated": truncated,
                "content": content
            }

        except Exception as e:
            logger.error(f"[ReadFile] Error reading {file_path}: {e}", exc_info=True)
            return {
                "file_path": file_path,
                "success": False,
                "error": str(e)
            }

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "read_file",
            "description": """Read and extract text content from files in the workspace. Supports batch reading of multiple files concurrently.

Supports PDFs (extracts text), Word docs, and all text-based files (txt, csv, json, code files, etc.).
For images (jpg, png, gif, webp, svg), use load_image() instead.

Single file: read_file(file_path="uploads/document.pdf")
Batch mode: read_file(file_paths=["uploads/doc1.pdf", "uploads/doc2.csv", "uploads/doc3.txt"])

Batch mode reads up to 20 files concurrently - much faster for multiple files!""",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Single file path within /workspace (e.g., 'uploads/document.pdf'). Use this OR file_paths, not both."
                    },
                    "file_paths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Array of file paths to read concurrently (e.g., ['uploads/doc1.pdf', 'uploads/doc2.csv']). Max 20 files per batch."
                    }
                }
            }
        }
    })
    async def read_file(
        self, 
        file_path: Optional[str] = None, 
        file_paths: Optional[List[str]] = None
    ) -> ToolResult:
        try:
            await self._ensure_sandbox()
            await self._wait_for_uploads()

            if file_paths:
                paths_to_read = file_paths[:MAX_BATCH_SIZE]
                if len(file_paths) > MAX_BATCH_SIZE:
                    logger.warning(f"[ReadFile] Batch limited to {MAX_BATCH_SIZE} files, {len(file_paths)} provided")
            elif file_path:
                paths_to_read = [file_path]
            else:
                return self.fail_response("Either 'file_path' or 'file_paths' must be provided.")

            if len(paths_to_read) == 1:
                result = await self._read_single_file(paths_to_read[0])
                if result.get("success"):
                    return self.success_response(result)
                else:
                    return self.fail_response(result.get("error", "Unknown error"))

            tasks = [self._read_single_file(path) for path in paths_to_read]
            results = await asyncio.gather(*tasks)

            successful = [r for r in results if r.get("success")]
            failed = [r for r in results if not r.get("success")]

            logger.info(f"[ReadFile] Batch read: {len(successful)} success, {len(failed)} failed out of {len(paths_to_read)} files")

            return self.success_response({
                "batch_mode": True,
                "total_files": len(paths_to_read),
                "successful": len(successful),
                "failed": len(failed),
                "results": results
            })

        except Exception as e:
            logger.error(f"[ReadFile] Error: {e}", exc_info=True)
            return self.fail_response(f"Error reading files: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "search_file",
            "description": """Semantic search within files - returns only relevant chunks instead of full content. MUCH better for large files!

Use this instead of read_file() for:
- Large PDFs and documents
- When looking for specific information
- Multiple files where you need to find something

Examples:
- search_file(file_path="uploads/contract.pdf", query="termination clause")
- search_file(file_paths=["uploads/doc1.pdf", "uploads/doc2.pdf"], query="payment terms")""",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language query to search for (e.g., 'What are the payment terms?', 'termination clause')"
                    },
                    "file_path": {
                        "type": "string",
                        "description": "Single file path to search within (e.g., 'uploads/contract.pdf')"
                    },
                    "file_paths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Multiple file paths to search across"
                    }
                },
                "required": ["query"]
            }
        }
    })
    async def search_file(
        self,
        query: str,
        file_path: Optional[str] = None,
        file_paths: Optional[List[str]] = None
    ) -> ToolResult:
        try:
            await self._ensure_sandbox()
            await self._wait_for_uploads()
            
            if not query or not query.strip():
                return self.fail_response("Query is required for search.")
            
            paths = []
            if file_paths:
                paths = [f"{self.workspace_path}/{self.clean_path(p)}" for p in file_paths]
            elif file_path:
                paths = [f"{self.workspace_path}/{self.clean_path(file_path)}"]
            else:
                paths = [f"{self.workspace_path}/uploads"]
            
            for p in paths:
                check = await self.sandbox.process.exec(f"test -e {shlex.quote(p)} && echo 'ok'")
                if "ok" not in check.result:
                    return self.fail_response(f"Path not found: {p}")
            
            if not await self._ensure_kb():
                return self.fail_response("Failed to initialize search. Try read_file() instead.")
            
            env = {"OPENAI_API_KEY": config.OPENAI_API_KEY} if config.OPENAI_API_KEY else {}
            
            path_args = " ".join([shlex.quote(p) for p in paths])
            escaped_query = shlex.quote(query)
            cmd = f"kb search {path_args} {escaped_query} -k 10 --json"
            
            result = await self.sandbox.process.exec(cmd, env=env, cwd=self.workspace_path, timeout=120)
            
            if result.exit_code != 0:
                logger.error(f"[SearchFile] kb search failed: {result.result}")
                return self.fail_response(f"Search failed: {result.result[:500]}")
            
            logger.info(f"[SearchFile] Raw kb output (first 1000 chars): {result.result[:1000]}")
            
            try:
                search_results = json.loads(result.result)
                
                total_hits = 0
                formatted_results = []
                
                for query_result in search_results:
                    q = query_result.get("query", query)
                    hits = query_result.get("hits", [])
                    total_hits += len(hits)
                    
                    if hits:
                        logger.info(f"[SearchFile] First hit structure: {list(hits[0].keys())}")
                    
                    for hit in hits[:10]:
                        content = hit.get("content") or hit.get("chunk") or hit.get("text") or hit.get("snippet") or ""
                        file_path = hit.get("file_path") or hit.get("path") or hit.get("file") or ""
                        
                        if not content and hit:
                            logger.info(f"[SearchFile] Hit has no content. Keys: {list(hit.keys())}, first 500 chars: {str(hit)[:500]}")
                        
                        formatted_results.append({
                            "file": file_path.replace(self.workspace_path + "/", ""),
                            "score": round(hit.get("score", 0), 3),
                            "content": content[:8000] if content else "[No content - check hit structure]"
                        })
                
                logger.info(f"[SearchFile] Found {total_hits} results for '{query}'")
                
                return self.success_response({
                    "query": query,
                    "total_hits": total_hits,
                    "results": formatted_results,
                    "note": "Showing top relevant chunks. Use read_file() if you need the complete file."
                })
                
            except json.JSONDecodeError:
                return self.success_response({
                    "query": query,
                    "raw_results": result.result[:5000]
                })
                
        except Exception as e:
            logger.error(f"[SearchFile] Error: {e}", exc_info=True)
            return self.fail_response(f"Search error: {str(e)}")
