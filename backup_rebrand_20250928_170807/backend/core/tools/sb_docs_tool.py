import json
import os
from typing import Optional, Dict, Any, List
from core.agentpress.tool import openapi_schema, usage_example
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
from core.utils.config import config
import uuid
from datetime import datetime
import re
from pathlib import Path
from core.agentpress.tool import ToolResult
import html

class SandboxDocsTool(SandboxToolsBase):
    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.docs_dir = "/workspace/docs"
        self.metadata_file = "/workspace/docs/.metadata.json"
        
    async def _ensure_docs_directory(self):
        await self._ensure_sandbox()
        try:
            await self.sandbox.fs.make_dir(self.docs_dir)
        except:
            pass
            
    async def _load_metadata(self) -> Dict[str, Any]:
        try:
            await self._ensure_sandbox()
            content = await self.sandbox.fs.download_file(self.metadata_file)
            return json.loads(content.decode())
        except:
            return {"documents": {}}
            
    async def _save_metadata(self, metadata: Dict[str, Any]):
        await self._ensure_sandbox()
        content = json.dumps(metadata, indent=2)
        await self.sandbox.fs.upload_file(content.encode(), self.metadata_file)
        
    def _generate_doc_id(self) -> str:
        return f"doc_{uuid.uuid4().hex[:8]}"
    
    def _get_tiptap_template_example(self) -> str:
        return """
<h1>Document Title</h1>
<p>This is a paragraph with <strong>bold text</strong> and <em>italic text</em>.</p>

<h2>Section with List</h2>
<p>Here's an unordered list:</p>
<ul>
  <li>First item</li>
  <li>Second item with <code>inline code</code></li>
  <li>Third item</li>
</ul>

<h2>Code Example</h2>
<p>Here's a code block:</p>
<pre><code>function hello() {
  console.log("Hello, World!");
}</code></pre>

<h2>Table Example</h2>
<table>
  <tr>
    <th>Header 1</th>
    <th>Header 2</th>
  </tr>
  <tr>
    <td>Cell 1</td>
    <td>Cell 2</td>
  </tr>
</table>

<blockquote>This is a blockquote for important notes.</blockquote>
"""
        
    def _sanitize_filename(self, title: str) -> str:
        filename = re.sub(r'[^\w\s-]', '', title.lower())
        filename = re.sub(r'[-\s]+', '-', filename)
        return filename[:50]
    
    def _validate_and_clean_tiptap_html(self, content: str) -> str:
        allowed_tags = {
            'p', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 
            'strong', 'em', 'u', 's', 'a', 'code', 'pre',
            'blockquote', 'img', 'table', 'thead', 'tbody',
            'tr', 'th', 'td', 'br', 'hr'
        }
        
        if not content.strip():
            return '<p></p>'
        
        content = content.strip()
        if not content.startswith('<'):
            content = f'<p>{html.escape(content)}</p>'
            
        content = re.sub(r'<script[^>]*>.*?</script>', '', content, flags=re.DOTALL | re.IGNORECASE)
        content = re.sub(r'<style[^>]*>.*?</style>', '', content, flags=re.DOTALL | re.IGNORECASE)
        content = re.sub(r'\s*on\w+\s*=\s*["\'][^"\']*["\']', '', content, flags=re.IGNORECASE)
        content = re.sub(r'javascript:', '', content, flags=re.IGNORECASE)
        
        content = re.sub(r'\s*style\s*=\s*["\'][^"\']*["\']', '', content, flags=re.IGNORECASE)
        
        content = re.sub(r'\s*class\s*=\s*["\'][^"\']*["\']', '', content, flags=re.IGNORECASE)
        
        content = re.sub(r'<code>([^<]+)</code>', r'<code>\1</code>', content)
        content = re.sub(r'<pre>([^<])', r'<pre><code>\1', content)
        content = re.sub(r'([^>])</pre>', r'\1</code></pre>', content)
        
        if '<li>' in content and not ('<ul>' in content or '<ol>' in content):
            content = re.sub(r'(<li>.*?</li>)+', r'<ul>\g<0></ul>', content, flags=re.DOTALL)
        
        if '<td>' in content or '<th>' in content:
            if '<table>' not in content:
                table_pattern = r'(<tr>.*?</tr>)+'
                content = re.sub(table_pattern, r'<table>\g<0></table>', content, flags=re.DOTALL)
        
        if not any(content.strip().startswith(f'<{tag}>') for tag in ['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'blockquote', 'pre', 'table']):
            content = f'<p>{content}</p>'
        
        return content
        
    async def _generate_viewer_html(self, title: str, content: str, doc_id: str, 
                                   metadata: Optional[Dict] = None, updated_at: str = "") -> str:
       
        template_path = Path(__file__).parent / "templates" / "doc_viewer.html"
        try:
            with open(template_path, 'r') as f:
                template = f.read()
        except:
            template = """
            <!DOCTYPE html>
            <html>
            <head>
                <title>{{title}}</title>
                <style>
                    body { font-family: sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; }
                    h1 { color: #333; }
                    .metadata { color: #666; font-size: 0.9rem; margin: 1rem 0; }
                    .content { line-height: 1.6; }
                </style>
            </head>
            <body>
                <h1>{{title}}</h1>
                <div class="metadata">Document ID: {{doc_id}}</div>
                <div class="content">{{content}}</div>
            </body>
            </html>
            """
        
        html = template.replace("{{title}}", title)
        html = html.replace("{{doc_id}}", doc_id)
        html = html.replace("{{content}}", content)
        html = html.replace("{{updated_at}}", updated_at)
        
        if metadata:
            if metadata.get("author"):
                html = html.replace("{{author}}", metadata["author"])
            else:
                html = re.sub(r'{{#if author}}.*?{{/if}}', '', html, flags=re.DOTALL)
            
            if metadata.get("tags"):
                tags_html = ' '.join([f'<span class="tag">{tag}</span>' for tag in metadata["tags"]])
                html = html.replace("{{#each tags}}<span class=\"tag\">{{this}}</span>{{/each}}", tags_html)
            else:
                html = re.sub(r'{{#if tags}}.*?{{/if}}', '', html, flags=re.DOTALL)
        else:
            html = re.sub(r'{{#if.*?}}.*?{{/if}}', '', html, flags=re.DOTALL)
        
        html = re.sub(r'{{.*?}}', '', html)
        
        return html
        
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_document",
            "description": "Create a new document with rich text content. The content should be properly formatted HTML compatible with TipTap editor.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Title of the document"
                    },
                    "content": {
                        "type": "string",
                        "description": """HTML content for TipTap editor. Use only these supported elements:
- Paragraphs: <p>text</p>
- Headings: <h1>, <h2>, <h3> (levels 1-3 only)
- Lists: <ul><li>item</li></ul> or <ol><li>item</li></ol>
- Formatting: <strong>bold</strong>, <em>italic</em>, <u>underline</u>, <s>strikethrough</s>
- Links: <a href="url">text</a>
- Code: <code>inline code</code> or <pre><code>block code</code></pre>
- Blockquotes: <blockquote>quote</blockquote>
- Images: <img src="url" alt="description" />
- Tables: <table><tr><th>Header</th></tr><tr><td>Cell</td></tr></table>
- Line breaks: <br />
- Horizontal rules: <hr />

IMPORTANT: All content must be wrapped in proper HTML tags. Do not use unsupported tags or attributes like style, class (except for standard TipTap classes), or custom elements. Start with a paragraph or heading tag."""
                    },
                    "format": {
                        "type": "string",
                        "enum": ["html", "markdown", "json"],
                        "description": "Format of the document",
                        "default": "html"
                    },
                    "metadata": {
                        "type": "object",
                        "description": "Additional metadata for the document",
                        "properties": {
                            "description": {"type": "string"},
                            "tags": {"type": "array", "items": {"type": "string"}},
                            "author": {"type": "string"}
                        }
                    }
                },
                "required": ["title", "content"]
            }
        }
    })
    @usage_example("""Create a document with TipTap-formatted HTML like:
    title="API Documentation", 
    content="<h1>API Overview</h1><p>This document describes our REST API.</p><h2>Authentication</h2><p>Use <code>Bearer token</code> in headers.</p><ul><li>Get token from /auth endpoint</li><li>Include in Authorization header</li></ul>"
    """)
    async def create_document(self, title: str, content: str, format: str = "html", metadata: Optional[Dict] = None) -> ToolResult:
        try:
            await self._ensure_docs_directory()

            doc_id = self._generate_doc_id()
            extension = "doc" if format == "html" else format
            filename = f"{self._sanitize_filename(title)}_{doc_id}.{extension}"
            file_path = f"{self.docs_dir}/{filename}"
            
            if format == "html":
                content = self._validate_and_clean_tiptap_html(content)
                logger.debug(f"Cleaned HTML content for TipTap: {content[:200]}...")
                
                document_wrapper = {
                    "type": "tiptap_document",
                    "version": "1.0",
                    "title": title,
                    "content": content,
                    "metadata": metadata or {},
                    "created_at": datetime.now().isoformat(),
                    "doc_id": doc_id
                }
                content_to_save = json.dumps(document_wrapper, indent=2)
            else:
                content_to_save = content
            
            await self.sandbox.fs.upload_file(content_to_save.encode(), file_path)
            
            all_metadata = await self._load_metadata()
            doc_info = {
                "id": doc_id,
                "title": title,
                "filename": filename,
                "format": format if format != "html" else "doc",
                "created_at": datetime.now().isoformat(),
                "updated_at": datetime.now().isoformat(),
                "metadata": metadata or {},
                "path": file_path,
                "is_tiptap_doc": format == "html",
                "doc_type": "tiptap_document" if format == "html" else "plain"
            }
            all_metadata["documents"][doc_id] = doc_info
            await self._save_metadata(all_metadata)
            
            preview_url = None
            if hasattr(self, '_sandbox_url') and self._sandbox_url:
                preview_url = f"{self._sandbox_url}/docs/{filename}"
            
            
            await self._ensure_sandbox()
            
            return self.success_response({
                "success": True,
                "document": doc_info,
                "content": content,
                "sandbox_id": self.sandbox_id,  
                "preview_url": preview_url,
                "message": f"Document '{title}' created successfully"
            })
            
        except Exception as e:
            logger.error(f"Error creating document: {str(e)}")
            return self.fail_response(f"Error creating document: {str(e)}")
            
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "read_document",
            "description": "Read the content of a document",
            "parameters": {
                "type": "object",
                "properties": {
                    "doc_id": {
                        "type": "string",
                        "description": "ID of the document to read"
                    }
                },
                "required": ["doc_id"]
            }
        }
    })
    async def read_document(self, doc_id: str) -> ToolResult:
        try:
            await self._ensure_sandbox()
            
            all_metadata = await self._load_metadata()
            
            if doc_id not in all_metadata["documents"]:
                return self.fail_response(f"Document with ID '{doc_id}' not found")
            
            doc_info = all_metadata["documents"][doc_id]
            
            content_raw = await self.sandbox.fs.download_file(doc_info["path"])
            content_str = content_raw.decode()
            

            if doc_info.get("format") in ["tiptap", "html", "doc"] or doc_info.get("is_tiptap_doc") or doc_info.get("doc_type") == "tiptap_document":
                try:
                    document_wrapper = json.loads(content_str)
                    if document_wrapper.get("type") == "tiptap_document":
                        content = document_wrapper.get("content", "")
                        doc_info["title"] = document_wrapper.get("title", doc_info["title"])
                        doc_info["metadata"] = document_wrapper.get("metadata", doc_info.get("metadata", {}))
                        doc_info["doc_type"] = "tiptap_document"
                    else:
                        content = content_str
                except json.JSONDecodeError:
                    content = content_str
            else:
                content = content_str
            
            preview_url = None
            if hasattr(self, '_sandbox_url') and self._sandbox_url:
                preview_url = f"{self._sandbox_url}/docs/{doc_info['filename']}"
            
            await self._ensure_sandbox()
            
            return self.success_response({
                "success": True,
                "document": doc_info,
                "content": content,
                "sandbox_id": self.sandbox_id,
                "preview_url": preview_url
            })
            
        except Exception as e:
            logger.error(f"Error reading document: {str(e)}")
            return self.fail_response(f"Error reading document: {str(e)}")
            
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_documents",
            "description": "List all documents in the workspace",
            "parameters": {
                "type": "object",
                "properties": {
                    "tag": {
                        "type": "string",
                        "description": "Filter documents by tag (optional)"
                    }
                }
            }
        }
    })
    async def list_documents(self, tag: Optional[str] = None) -> ToolResult:
        try:
            await self._ensure_sandbox()
            
            all_metadata = await self._load_metadata()
            documents = all_metadata.get("documents", {})
            
            if tag:
                documents = {
                    doc_id: doc_info 
                    for doc_id, doc_info in documents.items()
                    if tag in doc_info.get("metadata", {}).get("tags", [])
                }
            
            sorted_docs = sorted(
                documents.values(), 
                key=lambda x: x.get("updated_at", ""), 
                reverse=True
            )
            
            await self._ensure_sandbox()
            
            return self.success_response({
                "success": True,
                "documents": sorted_docs,
                "count": len(sorted_docs),
                "sandbox_id": self.sandbox_id
            })
            
        except Exception as e:
            logger.error(f"Error listing documents: {str(e)}")
            return self.fail_response(f"Error listing documents: {str(e)}")
            
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "delete_document",
            "description": "Delete a document from the workspace",
            "parameters": {
                "type": "object",
                "properties": {
                    "doc_id": {
                        "type": "string",
                        "description": "ID of the document to delete"
                    }
                },
                "required": ["doc_id"]
            }
        }
    })
    async def delete_document(self, doc_id: str) -> ToolResult:
        try:
            await self._ensure_sandbox()
            
            all_metadata = await self._load_metadata()
            
            if doc_id not in all_metadata["documents"]:
                return self.fail_response(f"Document with ID '{doc_id}' not found")
            
            doc_info = all_metadata["documents"][doc_id]
            
            try:
                await self.sandbox.fs.remove_file(doc_info["path"])
            except:
                pass

            del all_metadata["documents"][doc_id]
            await self._save_metadata(all_metadata)
            
            return self.success_response({
                "success": True,
                "message": f"Document '{doc_info['title']}' deleted successfully"
            })
            
        except Exception as e:
            logger.error(f"Error deleting document: {str(e)}")
            return self.fail_response(f"Error deleting document: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_format_guide",
            "description": "Get a guide and example of TipTap-compatible HTML format for creating or updating documents",
            "parameters": {
                "type": "object",
                "properties": {}
            }
        }
    })
    async def get_format_guide(self) -> ToolResult:
        guide = {
            "description": "TipTap is a rich text editor that uses clean, semantic HTML. Follow these guidelines for proper formatting.",
            "supported_elements": {
                "text_structure": {
                    "paragraphs": "<p>Your text here</p>",
                    "headings": ["<h1>Main Title</h1>", "<h2>Section</h2>", "<h3>Subsection</h3>"],
                    "line_breaks": "<br />",
                    "horizontal_rules": "<hr />"
                },
                "text_formatting": {
                    "bold": "<strong>bold text</strong>",
                    "italic": "<em>italic text</em>",
                    "underline": "<u>underlined text</u>",
                    "strikethrough": "<s>strikethrough text</s>",
                    "inline_code": "<code>code snippet</code>"
                },
                "lists": {
                    "unordered": "<ul><li>Item 1</li><li>Item 2</li></ul>",
                    "ordered": "<ol><li>First</li><li>Second</li></ol>",
                    "nested": "<ul><li>Item<ul><li>Nested item</li></ul></li></ul>"
                },
                "blocks": {
                    "blockquote": "<blockquote>Important quote</blockquote>",
                    "code_block": "<pre><code>// Code block\nconst x = 10;</code></pre>"
                },
                "links_and_media": {
                    "link": '<a href="https://example.com">Link text</a>',
                    "image": '<img src="image-url.jpg" alt="Description" />'
                },
                "tables": {
                    "basic": "<table><tr><th>Header</th></tr><tr><td>Cell</td></tr></table>",
                    "complex": "<table><thead><tr><th>Col1</th><th>Col2</th></tr></thead><tbody><tr><td>Data1</td><td>Data2</td></tr></tbody></table>"
                }
            },
            "important_rules": [
                "Always wrap content in proper HTML tags",
                "Start with a heading or paragraph tag",
                "Do not use inline styles (style attribute)",
                "Do not use custom CSS classes",
                "Ensure all tags are properly closed",
                "List items must be within <ul> or <ol> tags",
                "Code blocks should use <pre><code> together",
                "Table cells must be within <tr> tags"
            ],
            "example": self._get_tiptap_template_example().strip()
        }
        
        return self.success_response({
            "success": True,
            "guide": guide,
            "message": "Use this guide to format HTML content for TipTap editor"
        })
    