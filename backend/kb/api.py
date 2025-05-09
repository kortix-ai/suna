from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import mimetypes
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from services.supabase import get_supabase_client, SupabaseClient
from utils.auth_utils import get_current_user_id_from_jwt # Assuming you have this
from agent.tasks import process_kb_document_task # Import the actual task
from celery_app import celery_app # Assuming your celery app instance is here

router = APIRouter(
    prefix="/kb",
    tags=["Knowledge Base"],
)

class KBUpdateResponse(BaseModel):
    document_id: uuid.UUID
    file_name: str
    status: str
    message: str

# New Pydantic model for listing documents
class KBDocumentDisplay(BaseModel):
    id: uuid.UUID
    file_name: str
    created_at: datetime
    status: str
    error_message: Optional[str] = None
    mime_type: str
    file_size: int

# Define allowed MIME types for KB documents
# You can expand this list based on your needs
ALLOWED_KB_MIME_TYPES = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", # .docx
    "text/plain",
    "text/markdown",
    # Add other types like .txt, .md, potentially .csv if you want to process structured text
]

MAX_FILE_SIZE_MB = 25 # Max 25MB for example
MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024

@router.post("/projects/{project_id}/documents", response_model=KBUpdateResponse)
async def upload_kb_document(
    project_id: uuid.UUID,
    file: UploadFile = File(...),
    db: SupabaseClient = Depends(get_supabase_client),
    user_id: str = Depends(get_current_user_id_from_jwt)
):
    """
    Uploads a document to the Knowledge Base for a specific project.
    The file is stored in Supabase Storage, and a processing task is queued.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="File name is missing.")

    # Check file size
    file.file.seek(0, 2) # Move to the end of the file to get its size
    file_size = file.file.tell()
    file.file.seek(0) # Reset file pointer to the beginning
    if file_size > MAX_FILE_SIZE_BYTES:
        raise HTTPException(status_code=413, detail=f"File too large. Maximum size is {MAX_FILE_SIZE_MB}MB.")

    # Guess MIME type if not provided by browser, or validate provided one
    content_type = file.content_type
    if not content_type or content_type == "application/octet-stream": # Fallback if generic
        content_type, _ = mimetypes.guess_type(file.filename)
    
    if not content_type or content_type not in ALLOWED_KB_MIME_TYPES:
        allowed_types_str = ", ".join(ALLOWED_KB_MIME_TYPES)
        detail = f"Unsupported file type: {content_type}. Supported types are: {allowed_types_str}."
        if not content_type:
            detail = f"Could not determine file type. Supported types are: {allowed_types_str}."
        raise HTTPException(status_code=415, detail=detail)

    try:
        # Fetch the project to get its account_id and verify user access (implicitly via RLS)
        project_data_query = db.table("projects").select("account_id").eq("project_id", str(project_id)).maybe_single().execute()
        project_info = project_data_query.data
        if not project_info:
            raise HTTPException(status_code=404, detail=f"Project {project_id} not found or access denied.")
        
        account_id = project_info.get('account_id')
        if not account_id:
             raise HTTPException(status_code=500, detail="Project is missing account information.")

        # Define storage path: project_knowledge_bases/{project_id}/{uuid}_{filename}
        # Using a UUID in the filename helps prevent overwrites and adds uniqueness
        unique_file_id = uuid.uuid4()
        storage_file_name = f"{unique_file_id}_{file.filename}"
        storage_path = f"{project_id}/{storage_file_name}" # Path within the bucket
        bucket_name = "project_knowledge_bases"

        # Upload to Supabase Storage
        # The actual binary content of the file is in `file.file` (a SpooledTemporaryFile)
        upload_response = db.storage.from_(bucket_name).upload(
            path=storage_path,
            file=file.file, # Pass the file-like object
            file_options={"content-type": content_type, "cache-control": "3600"}
        )

        # Check for Supabase Storage upload errors if the API has changed (older versions might not raise HTTPExceptions)
        # Modern Supabase Python client usually raises an exception on failure.
        # If upload_response has an error attribute or a way to check status:
        # if hasattr(upload_response, 'error') and upload_response.error:
        #    raise HTTPException(status_code=500, detail=f"Failed to upload file to storage: {upload_response.error}")
        # if not upload_response.data or 'Key' not in upload_response.data: # Or similar check based on actual response
        #    raise HTTPException(status_code=500, detail="Failed to upload file to storage, no key returned.")

        # Insert metadata into knowledge_base_documents table
        kb_doc_data = {
            "project_id": str(project_id),
            "account_id": str(account_id),
            "file_name": file.filename,
            "storage_path": storage_path, # This is the path *within* the bucket
            "file_size": file_size,
            "mime_type": content_type,
            "status": "pending", # Initial status
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        insert_response = db.table("knowledge_base_documents").insert(kb_doc_data).execute()

        if not insert_response.data:
            # Attempt to delete the file from storage if DB insert fails
            try:
                db.storage.from_(bucket_name).remove([storage_path])
            except Exception as e_storage_cleanup:
                print(f"Error cleaning up storage after DB insert failure: {e_storage_cleanup}")
            raise HTTPException(status_code=500, detail="Failed to save document metadata to database.")

        document_id = insert_response.data[0]['id']

        # Trigger Celery task for processing
        process_kb_document_task.delay(str(document_id))

        return KBUpdateResponse(
            document_id=document_id,
            file_name=file.filename,
            status="pending",
            message="File uploaded successfully and queued for processing."
        )

    except HTTPException as http_exc:
        raise http_exc # Re-raise HTTPException
    except Exception as e:
        print(f"Unexpected error during KB document upload: {e}") # Log the full error for debugging
        # Attempt to cleanup storage if a file was partially uploaded and an error occurred later
        if 'storage_path' in locals() and 'bucket_name' in locals():
            try:
                db.storage.from_(bucket_name).remove([storage_path])
            except Exception as e_cleanup:
                print(f"Error during cleanup attempt after unexpected error: {e_cleanup}")
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {str(e)}")

@router.get("/projects/{project_id}/documents", response_model=List[KBDocumentDisplay])
async def list_kb_documents(
    project_id: uuid.UUID,
    db: SupabaseClient = Depends(get_supabase_client),
    user_id: str = Depends(get_current_user_id_from_jwt) # RLS will be enforced by Supabase policies
):
    """
    Lists all documents in the Knowledge Base for a specific project.
    RLS policies should ensure that the user can only access projects they are part of.
    """
    try:
        query_response = db.table("knowledge_base_documents").select(
            "id, file_name, created_at, status, error_message, mime_type, file_size"
        ).eq(
            "project_id", str(project_id)
        ).order(
            "created_at", desc=True
        ).execute()

        if query_response.data is None:
            # This case might occur if the table is empty or RLS prevents access,
            # but no rows match. An empty list is a valid response.
            # If there was a database error, Supabase client usually raises an exception.
            return []
        
        # Pydantic will validate the structure of each item in data
        documents = [KBDocumentDisplay(**doc) for doc in query_response.data]
        return documents

    except Exception as e:
        # Log the exception for debugging purposes
        print(f"Error listing KB documents for project {project_id}: {e}")
        # You might want to distinguish between "not found" (which RLS might handle as empty list)
        # and actual server errors. For now, a generic 500.
        raise HTTPException(status_code=500, detail="Failed to retrieve documents from the knowledge base.")

@router.delete("/projects/{project_id}/documents/{document_id}", status_code=204)
async def delete_kb_document(
    project_id: uuid.UUID,
    document_id: uuid.UUID,
    db: SupabaseClient = Depends(get_supabase_client),
    user_id: str = Depends(get_current_user_id_from_jwt) # RLS enforcement
):
    """
    Deletes a specific document from the Knowledge Base for a project.
    It also removes the associated file from Supabase Storage.
    RLS policies should ensure that the user can only delete documents from projects they have access to.
    """
    bucket_name = "project_knowledge_bases"

    try:
        # Step 1: Fetch the document to get storage_path and verify project_id and authorization (RLS)
        doc_query = db.table("knowledge_base_documents").select(
            "id, storage_path, project_id"
        ).eq(
            "id", str(document_id)
        ).maybe_single().execute()

        document_data = doc_query.data
        if not document_data:
            raise HTTPException(status_code=404, detail=f"Document with ID {document_id} not found.")

        # Explicitly check if the document belongs to the given project_id
        # RLS should already prevent access to documents from other projects the user can't see,
        # but this is an additional safeguard and verification.
        if str(document_data['project_id']) != str(project_id):
            raise HTTPException(status_code=403, detail=f"Document {document_id} does not belong to project {project_id}.")

        storage_path = document_data.get("storage_path")
        if not storage_path:
            # This case should ideally not happen if data integrity is maintained
            # If it does, we can still attempt to delete the DB record but log a warning.
            print(f"Warning: Document {document_id} in project {project_id} has no storage_path. Skipping storage deletion.")
        else:
            # Step 2: Delete the file from Supabase Storage
            try:
                delete_storage_response = db.storage.from_(bucket_name).remove([storage_path])
                # You might want to check delete_storage_response for errors if the client library provides that
                # For example, if it returns a list of successfully deleted items or raises an error.
                # If an error occurs here, we might choose to not delete the DB record or handle it differently.
            except Exception as e_storage:
                # Log the storage deletion error and potentially raise an HTTP error or decide to proceed
                print(f"Error deleting file {storage_path} from storage for document {document_id}: {e_storage}")
                # Depending on desired behavior, you could raise an HTTPException here.
                # For now, we'll proceed to delete the DB record even if storage deletion fails,
                # but this could lead to orphaned files. A more robust solution might involve a retry mechanism
                # or flagging the document for cleanup.
                raise HTTPException(status_code=500, detail=f"Failed to delete file from storage. Error: {str(e_storage)}")


        # Step 3: Delete the record from the knowledge_base_documents table
        # ON DELETE CASCADE on knowledge_base_chunks.document_id should handle chunks.
        delete_db_response = db.table("knowledge_base_documents").delete().eq("id", str(document_id)).execute()

        # Ensure at least one row was deleted.
        if not delete_db_response.data or len(delete_db_response.data) == 0:
            # This could happen if the document was deleted by another request between the fetch and delete operations.
            # Or if RLS prevented the delete after the initial select (less likely if user_id context is consistent).
            raise HTTPException(status_code=404, detail=f"Document {document_id} could not be deleted or was already deleted.")
        
        return None # FastAPI will return 204 No Content due to status_code=204

    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        print(f"Unexpected error deleting KB document {document_id} for project {project_id}: {e}")
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred while deleting the document: {str(e)}")

# You would also need to include this router in your main FastAPI application
# in api.py or wherever your main app is defined, e.g.:
# from kb import api as kb_api
# app.include_router(kb_api.router) 