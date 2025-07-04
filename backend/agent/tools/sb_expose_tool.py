from agentpress.tool import ToolResult, openapi_schema, xml_schema
from sandbox.tool_base import SandboxToolsBase
from agentpress.thread_manager import ThreadManager
import asyncio
import time

class SandboxExposeTool(SandboxToolsBase):
    """Tool for exposing and retrieving preview URLs for sandbox ports."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)

    async def _wait_for_sandbox_services(self, timeout: int = 30) -> bool:
        """Wait for sandbox services to be fully started before exposing ports."""
        start_time = time.time()
        
        while time.time() - start_time < timeout:
            try:
                # Check if supervisord is running and managing services
                result = await self.sandbox.process.exec("supervisorctl status", timeout=10)
                
                if result.exit_code == 0:
                    # Check if key services are running
                    status_output = result.output
                    if "http_server" in status_output and "RUNNING" in status_output:
                        return True
                
                # If services aren't ready, wait a bit
                await asyncio.sleep(2)
                
            except Exception as e:
                # If we can't check status, wait a bit and try again
                await asyncio.sleep(2)
        
        return False

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
        <function_calls>
        <invoke name="expose_port">
        <parameter name="port">8000</parameter>
        </invoke>
        </function_calls>

        <!-- Example 2: Expose an API service running on port 3000 -->
        <function_calls>
        <invoke name="expose_port">
        <parameter name="port">3000</parameter>
        </invoke>
        </function_calls>

        <!-- Example 3: Expose a development server running on port 5173 -->
        <function_calls>
        <invoke name="expose_port">
        <parameter name="port">5173</parameter>
        </invoke>
        </function_calls>
        '''
    )
    async def expose_port(self, port: int) -> ToolResult:
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            # Convert port to integer if it's a string
            port = int(port)
            
            # Validate port number
            if not 1 <= port <= 65535:
                return self.fail_response(f"Invalid port number: {port}. Must be between 1 and 65535.")

            # Wait for sandbox services to be ready (especially important for workflows)
            services_ready = await self._wait_for_sandbox_services()
            if not services_ready:
                return self.fail_response(f"Sandbox services are not fully started yet. Please wait a moment and try again, or ensure a service is running on port {port}.")

            # Check if something is actually listening on the port (for custom ports)
            if port not in [6080, 8080, 8003]:  # Skip check for known sandbox ports
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
