from typing import Optional
from agentpress.tool import ToolResult, openapi_schema, xml_schema
from sandbox.sandbox import SandboxToolsBase, Sandbox

class SandboxExposeTool(SandboxToolsBase):
    """Tool for exposing and retrieving preview URLs for sandbox ports."""

    def __init__(self, sandbox: Sandbox):
        super().__init__(sandbox)
        self.workspace_path = "/workspace"

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "expose_port",
            "description": "Expose a port from the agent's sandbox environment to the public internet and get its preview URL. This is essential for making services running in the sandbox accessible to users, such as web applications, APIs, or other network services. The exposed URL can be shared with users to allow them to interact with the sandbox environment.",
            "parameters": {
                "type": "object",
                "properties": {
                    "port": {
                        "type": "integer",
                        "description": "The port number to expose. Must be a valid port number between 1 and 65535.",
                        "minimum": 1,
                        "maximum": 65535
                    }
                },
                "required": ["port"]
            }
        }
    })
    @xml_schema(
        tag_name="expose-port",
        mappings=[
            {"param_name": "port", "node_type": "content", "path": "."}
        ],
        example='''
        <!-- Example 1: Expose a web server running on port 8000 -->
        <!-- This will generate a public URL that users can access to view the web application -->
        <expose-port>
        8000
        </expose-port>

        <!-- Example 2: Expose an API service running on port 3000 -->
        <!-- This allows users to interact with the API endpoints from their browser -->
        <expose-port>
        3000
        </expose-port>

        <!-- Example 3: Expose a development server running on port 5173 -->
        <!-- This is useful for sharing a development environment with users -->
        <expose-port>
        5173
        </expose-port>

        <!-- Example 4: Expose a database management interface on port 8081 -->
        <!-- This allows users to access database management tools like phpMyAdmin -->
        <expose-port>
        8081
        </expose-port>
        '''
    )
    async def expose_port(self, port: int) -> ToolResult:
        try:
            # Convert port to integer if it's a string
            port = int(port)
            
            # Validate port number
            if not 1 <= port <= 65535:
                return self.fail_response(f"Invalid port number: {port}. Must be between 1 and 65535.")

            # Get the preview link for the specified port
            preview_link = self.sandbox.get_preview_link(port)
            
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
