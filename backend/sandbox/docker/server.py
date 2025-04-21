from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
import uvicorn
import os

# Ensure we're serving from the /workspace directory
workspace_dir = "/workspace"

class WorkspaceDirMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Check if workspace directory exists and recreate if deleted
        if not os.path.exists(workspace_dir):
            print(f"Workspace directory {workspace_dir} not found, recreating...")
            os.makedirs(workspace_dir, exist_ok=True)
        return await call_next(request)

app = FastAPI()
app.add_middleware(WorkspaceDirMiddleware)

# Initial directory creation
os.makedirs(workspace_dir, exist_ok=True)
app.mount('/', StaticFiles(directory=workspace_dir, html=True), name='site')

# This is needed for the import string approach with uvicorn
if __name__ == '__main__':
    print(f"Starting server with auto-reload, serving files from: {workspace_dir}")
    # Don't use reload directly in the run call
    uvicorn.run("server:app", host="0.0.0.0", port=8099, reload=True) 