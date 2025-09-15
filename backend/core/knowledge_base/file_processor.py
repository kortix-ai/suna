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
            if file_extension not in self.SUPPORTED_EXTENSIONS:
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
                raise ValueError("No extractable content found")
            
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
        """Generate LLM summary of file content."""
        try:
            prompt = f"""Create a concise summary of this file for use in an AI agent's knowledge base.

File: {filename}
Content: {content[:8000]}

Generate a 2-3 sentence summary that captures:
1. What this file contains
2. Key information or purpose
3. When this knowledge would be useful

Keep it under 200 words and make it actionable for context injection."""

            messages = [{"role": "user", "content": prompt}]
            
            response = await make_llm_api_call(
                messages=messages,
                model_name="anthropic/claude-4-sonnet",
                temperature=0.1,
                max_tokens=300
            )
            
            summary = response.choices[0].message.content.strip()
            
            # Ensure summary is never empty
            if not summary:
                summary = f"File '{filename}' contains {len(content)} characters of content."
            
            return summary
            
        except Exception as e:
            logger.error(f"Error generating summary: {str(e)}")
            # Ensure fallback is never empty
            fallback = f"File '{filename}' uploaded successfully. Content length: {len(content)} characters."
            return fallback
    
    def _extract_content(self, file_content: bytes, filename: str, mime_type: str) -> str:
        """Extract text content from file bytes."""
        file_extension = Path(filename).suffix.lower()
        
        try:
            if file_extension == '.txt' or mime_type.startswith('text/'):
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
            
            return ""
            
        except Exception as e:
            logger.error(f"Error extracting content from {filename}: {str(e)}")
            return "" 