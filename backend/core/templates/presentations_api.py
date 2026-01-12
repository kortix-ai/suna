"""
API endpoints for serving presentation template static files (images, PDFs, slides).
"""
import os
import re
import json
from typing import List, Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel
from urllib.parse import quote

from core.utils.logger import logger

router = APIRouter(tags=["presentations"])

# Base path for presentation templates
TEMPLATES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "presentations"))


class SlideInfo(BaseModel):
    number: int
    filename: str
    
    
class TemplateInfo(BaseModel):
    id: str
    name: str
    slide_count: int
    slides: List[SlideInfo]


def _validate_template_path(template_name: str, filename: str) -> str:
    """
    Validate and return the absolute path for a template file.
    Raises HTTPException if path is invalid or file doesn't exist.
    """
    file_path = os.path.abspath(os.path.join(TEMPLATES_DIR, template_name, filename))
    
    # Security check: ensure path is within templates directory
    if not file_path.startswith(TEMPLATES_DIR):
        raise HTTPException(status_code=403, detail="Access denied")
    
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")
    
    return file_path


@router.get("/{template_name}/image.png", summary="Get Presentation Template Image")
async def get_presentation_template_image(template_name: str):
    """Serve presentation template preview images."""
    try:
        image_path = _validate_template_path(template_name, "image.png")
        return FileResponse(image_path, media_type="image/png")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error serving template image: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/{template_name}/pdf", summary="Get Presentation Template PDF")
async def get_presentation_template_pdf(template_name: str):
    """Serve presentation template PDF files."""
    try:
        pdf_folder = os.path.abspath(os.path.join(TEMPLATES_DIR, template_name, "pdf"))
        
        # Security check
        if not pdf_folder.startswith(TEMPLATES_DIR):
            raise HTTPException(status_code=403, detail="Access denied")
        
        if not os.path.exists(pdf_folder):
            raise HTTPException(status_code=404, detail="Template PDF folder not found")
        
        # Find the first PDF file in the folder
        pdf_files = [f for f in os.listdir(pdf_folder) if f.lower().endswith('.pdf')]
        
        if not pdf_files:
            raise HTTPException(status_code=404, detail="No PDF file found in template")
        
        pdf_path = os.path.join(pdf_folder, pdf_files[0])
        
        encoded_filename = quote(f"{template_name}.pdf", safe="")
        return FileResponse(
            pdf_path,
            media_type="application/pdf",
            headers={"Content-Disposition": f"inline; filename*=UTF-8''{encoded_filename}"}
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error serving template PDF: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/{template_name}/info", summary="Get Template Info", response_model=TemplateInfo)
async def get_template_info(template_name: str):
    """Get template metadata including list of slides."""
    try:
        template_folder = os.path.abspath(os.path.join(TEMPLATES_DIR, template_name))
        
        # Security check
        if not template_folder.startswith(TEMPLATES_DIR):
            raise HTTPException(status_code=403, detail="Access denied")
        
        if not os.path.exists(template_folder):
            raise HTTPException(status_code=404, detail="Template not found")
        
        # Find all slide HTML files
        slide_pattern = re.compile(r'^slide_(\d+)\.html$')
        slides = []
        
        for filename in os.listdir(template_folder):
            match = slide_pattern.match(filename)
            if match:
                slide_num = int(match.group(1))
                slides.append(SlideInfo(number=slide_num, filename=filename))
        
        # Sort by slide number
        slides.sort(key=lambda s: s.number)
        
        # Try to get name from metadata.json if exists
        metadata_path = os.path.join(template_folder, "metadata.json")
        name = template_name.replace('_', ' ').title()
        if os.path.exists(metadata_path):
            try:
                with open(metadata_path, 'r') as f:
                    metadata = json.load(f)
                    name = metadata.get('name', name)
            except Exception:
                pass
        
        return TemplateInfo(
            id=template_name,
            name=name,
            slide_count=len(slides),
            slides=slides
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting template info: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/{template_name}/slides/{slide_number}", summary="Get Slide HTML")
async def get_slide_html(template_name: str, slide_number: int):
    """Serve individual slide HTML file."""
    try:
        filename = f"slide_{slide_number:02d}.html"
        slide_path = _validate_template_path(template_name, filename)
        
        # Read and return HTML with proper headers for iframe embedding
        with open(slide_path, 'r', encoding='utf-8') as f:
            html_content = f.read()
        
        return HTMLResponse(
            content=html_content,
            headers={
                "X-Frame-Options": "SAMEORIGIN",
                "Content-Security-Policy": "frame-ancestors 'self' http://localhost:* https://*.kortix.com https://*.suna.so",
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error serving slide HTML: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/{template_name}/assets/{filename:path}", summary="Get Template Asset")
async def get_template_asset(template_name: str, filename: str):
    """Serve template asset files (images, etc.)."""
    try:
        asset_path = _validate_template_path(template_name, filename)
        
        # Determine media type based on extension
        ext = os.path.splitext(filename)[1].lower()
        media_types = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.webp': 'image/webp',
        }
        media_type = media_types.get(ext, 'application/octet-stream')
        
        return FileResponse(asset_path, media_type=media_type)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error serving template asset: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

