from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
import asyncio
import time

@tool_metadata(
    display_name="Port Exposure",
    description="Expose custom development servers (NOT for port 8080 - already auto-exposed)",
    icon="Share",
    color="bg-indigo-100 dark:bg-indigo-800/50",
    weight=120,
    visible=True,
    usage_guide="""
### PORT EXPOSURE & WEB DEVELOPMENT

**⚠️ YOU PROBABLY DON'T NEED THIS TOOL! ⚠️**

**PORT 8080 IS AUTO-EXPOSED - HTML FILES GET AUTOMATIC PREVIEW URLS:**
- When you create HTML files with `create_file` or `full_file_rewrite`, they automatically get preview URLs
- Example: Create `dashboard.html` → Tool returns `https://8080-xxx.works/dashboard.html`
- NO need to expose ports, start servers, or use this tool for static HTML files
- NO need to use `wait` tool - files are instantly accessible

**WHEN TO USE THIS TOOL:**
- ONLY for custom development servers running on ports OTHER than 8080
- Example: React dev server on port 3000, API server on port 5000
- For port 8080 HTML files: Just create the file and use the URL from the tool response

**WHAT NOT TO DO:**
- ❌ Use this tool for port 8080 (already exposed)
- ❌ Use this tool for HTML files (they auto-get preview URLs)
- ❌ Start `python -m http.server` or similar (not needed)
- ❌ Use `wait` tool after creating HTML files

**SUMMARY:**
Static HTML on 8080? → Just create_file, get URL automatically ✅
Custom server on other port? → Use this tool ✅
"""
)
class SandboxExposeTool(SandboxToolsBase):
    """Tool for exposing and retrieving preview URLs for sandbox ports."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "expose_port",
            "description": "Expose a CUSTOM port from the sandbox (NOT port 8080 - already auto-exposed). **IMPORTANT**: Port 8080 is automatically exposed. When you create HTML files with create_file or full_file_rewrite, they automatically return preview URLs. You ONLY need this tool for custom dev servers running on OTHER ports (like React on 3000, API on 5000, etc.). For static HTML files on port 8080, just create the file and the tool will give you the URL - no need to expose or wait. **🚨 PARAMETER NAMES**: Use EXACTLY this parameter name: `port` (REQUIRED).",
            "parameters": {
                "type": "object",
                "properties": {
                    "port": {
                        "type": "integer",
                        "description": "**REQUIRED** - The port number to expose (DO NOT use 8080 - already auto-exposed). Use this ONLY for custom development servers on other ports. Minimum: 1, Maximum: 65535.",
                        "minimum": 1,
                        "maximum": 65535
                    }
                },
                "required": ["port"],
                "additionalProperties": False
            }
        }
    })
    async def expose_port(self, port: int) -> ToolResult:
        try:
            await self._ensure_sandbox()
            
            port = int(port)
            
            if not 1 <= port <= 65535:
                return self.fail_response(f"Invalid port number: {port}. Must be between 1 and 65535.")

            if port == 8080:
                return self.fail_response(
                    "Port 8080 is already auto-exposed! You don't need this tool for port 8080. "
                    "When you create HTML files with create_file or full_file_rewrite, they automatically get preview URLs. "
                    "Just create your HTML file and use the URL from the tool response."
                )

            if port not in [6080, 8003]:  # Skip check for known sandbox ports
                try:
                    port_check = await self.sandbox.process.exec(f"netstat -tlnp | grep :{port}", timeout=5)
                    if port_check.exit_code != 0:
                        return self.fail_response(f"No service is currently listening on port {port}. Please start a service on this port first.")
                except Exception:
                    # If we can't check, proceed anyway - the user might be starting a service
                    pass

            # Get the preview link for the specified port
            preview_link = await self.sandbox.get_preview_link(port)
            
            # Extract the actual URL from the preview link object
            url = preview_link.url if hasattr(preview_link, 'url') else str(preview_link)
            
            return self.success_response({
                "url": url,
                "port": port,
                "message": f"Successfully exposed port {port} to the public. Users can now access this service at: {url}"
            })
                
        except ValueError:
            return self.fail_response(f"Invalid port number: {port}. Must be a valid integer between 1 and 65535.")
        except Exception as e:
            return self.fail_response(f"Error exposing port {port}: {str(e)}")
