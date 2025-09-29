import os
import io
import uuid
import re
from typing import Dict, Any
from pathlib import Path
import mimetypes
import chardet

import PyPDF2
import docx

from core.utils.logger import logger
from core.services.supabase import DBConnection
from core.services.llm import make_llm_api_call

class FileProcessor:
    SUPPORTED_EXTENSIONS = {'.txt', '.pdf', '.docx'}
    MAX_FILE_SIZE = 50 * 1024 * 1024
    
    def __init__(self):
        self.db = DBConnection()
    
    def sanitize_filename(self, filename: str) -> str:
        """Sanitize filename for S3 storage - remove/replace invalid characters."""
        # Keep the file extension
        name, ext = os.path.splitext(filename)
        
        # Replace emojis and other problematic Unicode characters with underscores
        name = re.sub(r'[^\w\s\-\.]', '_', name)
        
        # Replace spaces with underscores
        name = re.sub(r'\s+', '_', name)
        
        # Remove multiple consecutive underscores
        name = re.sub(r'_+', '_', name)
        
        # Remove leading/trailing underscores
        name = name.strip('_')
        
        # Ensure name is not empty
        if not name:
            name = 'file'
        
        return f"{name}{ext}"
    
    def _is_likely_text_file(self, file_content: bytes) -> bool:
        """Check if file content is likely text-based."""
        try:
            # Try to decode as text
            detected = chardet.detect(file_content[:1024])  # Check first 1KB
            if detected.get('confidence', 0) > 0.7:
                decoded = file_content[:1024].decode(detected.get('encoding', 'utf-8'))
                # Check if most characters are printable
                printable_ratio = len([c for c in decoded if c.isprintable() or c.isspace()]) / len(decoded)
                return printable_ratio > 0.8
        except:
            pass
        return False
    
    async def process_file(
        self, 
        account_id: str, 
        folder_id: str,
        file_content: bytes, 
        filename: str, 
        mime_type: str
    ) -> Dict[str, Any]:
        try:
            if len(file_content) > self.MAX_FILE_SIZE:
                raise ValueError(f"File too large: {len(file_content)} bytes")
            
            file_extension = Path(filename).suffix.lower()
            
            # Check if it's text-based first
            is_text_based = (
                mime_type.startswith('text/') or 
                mime_type in ['application/json', 'application/xml', 'text/xml'] or
                self._is_likely_text_file(file_content)
            )
            
            # If not text-based, check allowed extensions
            if not is_text_based and file_extension not in self.SUPPORTED_EXTENSIONS:
                raise ValueError(f"Unsupported file type: {file_extension}")
            
            # Generate unique entry ID
            entry_id = str(uuid.uuid4())
            
            # Sanitize filename for S3 storage
            sanitized_filename = self.sanitize_filename(filename)
            
            # Upload to S3
            s3_path = f"knowledge-base/{folder_id}/{entry_id}/{sanitized_filename}"
            client = await self.db.client
            
            await client.storage.from_('file-uploads').upload(
                s3_path, file_content, {"content-type": mime_type}
            )
            
            # Extract content for summary
            content = self._extract_content(file_content, filename, mime_type)
            if not content:
                # If no content could be extracted, create a basic file info summary
                content = f"File: {filename} ({len(file_content)} bytes, {mime_type})"
            
            # Generate LLM summary
            summary = await self._generate_summary(content, filename)
            
            # Save to database
            entry_data = {
                'entry_id': entry_id,
                'folder_id': folder_id,
                'account_id': account_id,
                'filename': filename,
                'file_path': s3_path,
                'file_size': len(file_content),
                'mime_type': mime_type,
                'summary': summary,
                'is_active': True
            }
            
            result = await client.table('knowledge_base_entries').insert(entry_data).execute()
            
            return {
                'success': True,
                'entry_id': entry_id,
                'filename': filename,
                'summary_length': len(summary)
            }
            
        except Exception as e:
            logger.error(f"Error processing file {filename}: {str(e)}")
            return {'success': False, 'error': str(e)}
    
    async def _generate_summary(self, content: str, filename: str) -> str:
        """Generate LLM summary of file content with smart chunking and fallbacks."""
        try:
            # Model priority: Google Gemini → OpenRouter → GPT-5 Mini
            models = [
                ("google/gemini-2.5-flash-lite", 1_000_000),  # 1M context
                ("openrouter/google/gemini-2.5-flash-lite", 1_000_000),  # Fallback
                ("gpt-5-mini", 400_000)  # Final fallback
            ]
            
            # Estimate tokens (rough: 1 token ≈ 4 chars)
            estimated_tokens = len(content) // 4
            
            for model_name, context_limit in models:
                try:
                    # Reserve tokens for prompt and response
                    usable_context = context_limit - 1000  # Reserve for prompt + response
                    
                    if estimated_tokens <= usable_context:
                        # Content fits, use full content
                        processed_content = content
                    else:
                        # Content too large, intelligent chunking
                        processed_content = self._smart_chunk_content(content, usable_context * 4)  # Convert back to chars
                    
                    prompt = f"""Analyze this file and create a concise, actionable summary for an AI agent's knowledge base.

File: {filename}
Content: {processed_content}

Generate a 2-3 sentence summary that captures:
1. What this file contains
2. Key information or purpose  
3. When this knowledge would be useful

Keep it under 200 words and make it actionable for context injection."""

                    messages = [{"role": "user", "content": prompt}]
                    
                    response = await make_llm_api_call(
                        messages=messages,
                        model_name=model_name,
                        temperature=0.1,
                        max_tokens=300
                    )
                    
                    summary = response.choices[0].message.content.strip()
                    
                    if summary:
                        logger.info(f"Summary generated successfully using {model_name}")
                        return summary
                        
                except Exception as e:
                    logger.warning(f"Model {model_name} failed: {str(e)}")
                    continue
            
            # All models failed - high-reliability fallback
            logger.error("All LLM models failed, using intelligent fallback")
            return self._create_fallback_summary(content, filename)
            
        except Exception as e:
            logger.error(f"Error generating summary: {str(e)}")
            return self._create_fallback_summary(content, filename)
    
    def _smart_chunk_content(self, content: str, max_chars: int) -> str:
        """Intelligently chunk content to fit context limits."""
        if len(content) <= max_chars:
            return content
        
        # Strategy: Take beginning + end with priority sections
        quarter = max_chars // 4
        
        # Always include beginning (most important)
        beginning = content[:quarter * 2]
        
        # Include end for conclusion/summary
        ending = content[-quarter:]
        
        # Try to find important middle sections (headers, key terms)
        middle_section = ""
        remaining_chars = max_chars - len(beginning) - len(ending) - 100  # Buffer
        
        if remaining_chars > 0:
            middle_start = len(beginning)
            middle_end = len(content) - quarter
            middle_content = content[middle_start:middle_end]
            
            # Look for important sections (lines with caps, numbers, bullets)
            lines = middle_content.split('\n')
            important_lines = []
            current_length = 0
            
            for line in lines:
                line_stripped = line.strip()
                if not line_stripped:
                    continue
                    
                # Prioritize lines that look important
                is_important = (
                    line_stripped.isupper() or  # Headers
                    line_stripped.startswith(('•', '-', '*', '1.', '2.')) or  # Lists
                    any(keyword in line_stripped.lower() for keyword in ['summary', 'conclusion', 'important', 'key', 'main']) or
                    len(line_stripped) < 100  # Short lines often important
                )
                
                if is_important and current_length + len(line) < remaining_chars:
                    important_lines.append(line)
                    current_length += len(line)
            
            if important_lines:
                middle_section = '\n'.join(important_lines)
        
        # Combine sections
        if middle_section:
            return f"{beginning}\n\n[KEY SECTIONS]\n{middle_section}\n\n[ENDING]\n{ending}"
        else:
            return f"{beginning}\n\n[...content truncated...]\n\n{ending}"
    
    def _create_fallback_summary(self, content: str, filename: str) -> str:
        """Create intelligent fallback summary when LLM fails."""
        # Extract first meaningful portion
        preview = content[:2000].strip()
        
        # Basic content analysis
        lines = content.split('\n')
        non_empty_lines = [line.strip() for line in lines if line.strip()]
        
        # Try to identify content type
        content_type = "document"
        if filename.endswith('.py'):
            content_type = "Python code"
        elif filename.endswith('.js'):
            content_type = "JavaScript code"
        elif filename.endswith('.md'):
            content_type = "Markdown document"
        elif filename.endswith('.txt'):
            content_type = "text document"
        elif filename.endswith('.csv'):
            content_type = "CSV data file"
        
        # Generate intelligent fallback
        return f"This {content_type} '{filename}' contains {len(content):,} characters across {len(non_empty_lines)} lines. Preview: {preview[:200]}{'...' if len(preview) > 200 else ''} This file would be useful for understanding the specific content and context it provides."
    
    def _extract_content(self, file_content: bytes, filename: str, mime_type: str) -> str:
        """Extract text content from file bytes."""
        file_extension = Path(filename).suffix.lower()
        
        try:
            # Handle text-based files (including JSON, XML, CSV, etc.)
            if (file_extension in ['.txt', '.json', '.xml', '.csv', '.yml', '.yaml', '.md', '.log', '.ini', '.cfg', '.conf'] 
                or mime_type.startswith('text/') 
                or mime_type in ['application/json', 'application/xml', 'text/xml']):
                
                detected = chardet.detect(file_content)
                encoding = detected.get('encoding', 'utf-8')
                try:
                    return file_content.decode(encoding)
                except UnicodeDecodeError:
                    return file_content.decode('utf-8', errors='replace')
            
            elif file_extension == '.pdf':
                pdf_reader = PyPDF2.PdfReader(io.BytesIO(file_content))
                return '\n\n'.join(page.extract_text() for page in pdf_reader.pages)
            
            elif file_extension == '.docx':
                doc = docx.Document(io.BytesIO(file_content))
                return '\n'.join(paragraph.text for paragraph in doc.paragraphs)
            
            # For any other file type, try to decode as text (fallback)
            else:
                try:
                    detected = chardet.detect(file_content)
                    encoding = detected.get('encoding', 'utf-8')
                    content = file_content.decode(encoding)
                    # Only return if it seems to be mostly text content
                    if len([c for c in content[:1000] if c.isprintable() or c.isspace()]) > 800:
                        return content
                except:
                    pass
                
                # If we can't extract text content, return a placeholder
                return f"[Binary file: {filename}] - Content cannot be extracted as text, but file is stored and available for download."
            
        except Exception as e:
            logger.error(f"Error extracting content from {filename}: {str(e)}")
            return f"[Error extracting content from {filename}] - File is stored but content extraction failed: {str(e)}" 