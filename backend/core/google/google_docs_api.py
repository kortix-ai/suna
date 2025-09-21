import httpx
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field

from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from core.services.supabase import DBConnection
from .google_docs_service import GoogleDocsService
from .google_slides_service import OAuthTokenService

class ConvertToDocsRequest(BaseModel):
    doc_path: str = Field(..., description="Path to the document file in sandbox")
    sandbox_url: str = Field(..., description="URL of the sandbox service")


class ConvertToDocsResponse(BaseModel):
    success: bool = Field(..., description="Whether the conversion was successful")
    message: str = Field(..., description="Status message")
    docx_url: Optional[str] = Field(None, description="URL to the generated DOCX file (if stored locally)")
    google_docs_url: Optional[str] = Field(None, description="Google Docs URL for the document")
    google_docs_file_id: Optional[str] = Field(None, description="Google Drive file ID")
    is_api_enabled: bool = Field(default=True, description="Whether Google API is enabled")


async def get_db_connection() -> DBConnection:
    db = DBConnection()
    await db.initialize()
    return db


async def get_oauth_service(db: DBConnection = Depends(get_db_connection)) -> OAuthTokenService:
    return OAuthTokenService(db)


async def get_google_docs_service(oauth_service: OAuthTokenService = Depends(get_oauth_service)) -> GoogleDocsService:
    return GoogleDocsService(oauth_service)


main_router = APIRouter()

docs_router = APIRouter(prefix="/document-tools", tags=["document-tools"])

@docs_router.get("/debug")
async def debug_endpoint():
    logger.info("DEBUG: Document tools debug endpoint hit")
    return {"status": "ok", "message": "Document tools router is working"}

@docs_router.post("/convert-and-upload-to-docs", response_model=ConvertToDocsResponse)
async def convert_and_upload_to_google_docs(
    request: ConvertToDocsRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    google_service: GoogleDocsService = Depends(get_google_docs_service)
):
    try:
        is_authenticated = await google_service.is_user_authenticated(user_id)

        if not is_authenticated:
            logger.info("User not authenticated with Google, returning auth required response")
            response = ConvertToDocsResponse(
                success=False,
                message="User not authenticated with Google. Please authenticate first.",
                docx_url=None,
                is_api_enabled=False
            )
            return response

        convert_url = f"{request.sandbox_url}/document/convert-to-docx"
        convert_payload = {
            "doc_path": request.doc_path,
            "download": True, 
        }
        logger.info(f"Calling sandbox conversion endpoint: POST {convert_url}")
        logger.debug(f"Conversion payload: {convert_payload}")
        
        async with httpx.AsyncClient(timeout=120.0) as client:
            convert_response = await client.post(
                convert_url,
                json=convert_payload
            )
            
            logger.debug(f"Sandbox response status: {convert_response.status_code}")
            
            if not convert_response.is_success:
                try:
                    error_detail = convert_response.json().get("detail", "Unknown error")
                except:
                    error_detail = convert_response.text
                logger.error(f"Sandbox conversion failed: {error_detail}")
                raise HTTPException(
                    status_code=convert_response.status_code,
                    detail=f"DOCX conversion failed: {error_detail}"
                )
            
            docx_content = convert_response.content
            
            filename = "document.docx" 
            content_disposition = convert_response.headers.get("Content-Disposition", "")
            if "filename=" in content_disposition:
                filename = content_disposition.split('filename="')[1].split('"')[0]
        
        logger.info(f"DOCX conversion successful: {filename}")
        
       
        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as temp_file:
            temp_docx_path = Path(temp_file.name)
            temp_file.write(docx_content)
            temp_file.flush()  
        
        
        try:
            document_name = filename.replace(".docx", "")
            
            upload_result = await google_service.upload_docx_to_docs(
                docx_file_path=temp_docx_path,
                user_id=user_id,
                document_name=document_name
            )
            return ConvertToDocsResponse(
                success=True,
                message=f"Successfully converted and uploaded to Google Docs",
                docx_url=None, 
                google_docs_url=upload_result["web_view_link"],
                google_docs_file_id=upload_result["file_id"]
            )
            
        finally:
            try:
                temp_docx_path.unlink()
            except:
                pass  
    
    except HTTPException as he:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


main_router.include_router(docs_router)
router = main_router
