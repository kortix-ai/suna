"""
API endpoints for serving presentation template static files (images, PDFs).
"""
import os
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from urllib.parse import quote

from core.utils.logger import logger

router = APIRouter(tags=["presentations"])

# Base path for presentation templates
TEMPLATES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "presentations"))


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

