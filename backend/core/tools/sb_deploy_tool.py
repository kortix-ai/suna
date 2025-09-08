import os
from dotenv import load_dotenv
from core.agentpress.tool import ToolResult, openapi_schema, usage_example
from core.sandbox.tool_base import SandboxToolsBase
from core.utils.files_utils import clean_path
from core.agentpress.thread_manager import ThreadManager

# Load environment variables
load_dotenv()

class SandboxDeployTool(SandboxToolsBase):
    """Tool for deploying static websites from a Daytona sandbox to Cloudflare Pages."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.workspace_path = "/workspace"  # Ensure we're always operating in /workspace
        self.cloudflare_api_token = os.getenv("CLOUDFLARE_API_TOKEN")

    def clean_path(self, path: str) -> str:
        """Clean and normalize a path to be relative to /workspace"""
        return clean_path(path, self.workspace_path)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "deploy",
            "description": "Deploy a static website (HTML+CSS+JS) from a directory in the sandbox to Cloudflare Pages. Only use this tool when permanent deployment to a production environment is needed. The directory path must be relative to /workspace. The website will be deployed to {name}.kortix.cloud.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Name for the deployment, will be used in the URL as {name}.kortix.cloud"
                    },
                    "directory_path": {
                        "type": "string",
                        "description": "Path to the directory containing the static website files to deploy, relative to /workspace (e.g., 'build')"
                    }
                },
                "required": ["name", "directory_path"]
            }
        }
    })
    @usage_example('''
        <!-- 
        IMPORTANT: Only use this tool when:
        1. The user explicitly requests permanent deployment to production
        2. You have a complete, ready-to-deploy directory 
        
        NOTE: If the same name is used, it will redeploy to the same project as before
        -->

        <function_calls>
        <invoke name="deploy">
        <parameter name="name">my-site</parameter>
        <parameter name="directory_path">website</parameter>
        </invoke>
        </function_calls>
        ''')
    async def deploy(self, name: str, directory_path: str) -> ToolResult:
        """
        Deploy a static website (HTML+CSS+JS) from the sandbox to Cloudflare Pages.
        Only use this tool when permanent deployment to a production environment is needed.
        
        Args:
            name: Name for the deployment, will be used in the URL as {name}.kortix.cloud
            directory_path: Path to the directory to deploy, relative to /workspace
            
        Returns:
            ToolResult containing:
            - Success: Deployment information including URL
            - Failure: Error message if deployment fails
        """
        try:
            # Ensure sandbox is initialized
            await self._ensure_sandbox()
            
            directory_path = self.clean_path(directory_path)
            full_path = f"{self.workspace_path}/{directory_path}"
            
            # Verify the directory exists
            try:
                dir_info = await self.sandbox.fs.get_file_info(full_path)
                if not dir_info.is_dir:
                    return self.fail_response(f"'{directory_path}' is not a directory")
            except Exception as e:
                return self.fail_response(f"Directory '{directory_path}' does not exist: {str(e)}")
            
            # Deploy to Cloudflare Pages directly from the container
            try:
                # Get Cloudflare API token from environment
                if not self.cloudflare_api_token:
                    return self.fail_response("CLOUDFLARE_API_TOKEN environment variable not set")
                    
                # Single command that creates the project if it doesn't exist and then deploys
                project_name = f"{self.sandbox_id}-{name}"
                deploy_cmd = f'''cd {self.workspace_path} && export CLOUDFLARE_API_TOKEN={self.cloudflare_api_token} && 
                    (npx wrangler pages deploy {full_path} --project-name {project_name} || 
                    (npx wrangler pages project create {project_name} --production-branch production && 
                    npx wrangler pages deploy {full_path} --project-name {project_name}))'''

                # Execute the command directly using the sandbox's process.exec method
                response = await self.sandbox.process.exec(f"/bin/sh -c \"{deploy_cmd}\"",
                                 timeout=300)
                
                print(f"Deployment command output: {response.result}")
                
                if response.exit_code == 0:
                    return self.success_response({
                        "message": f"Website deployed successfully",
                        "output": response.result
                    })
                else:
                    return self.fail_response(f"Deployment failed with exit code {response.exit_code}: {response.result}")
            except Exception as e:
                return self.fail_response(f"Error during deployment: {str(e)}")
        except Exception as e:
            return self.fail_response(f"Error deploying website: {str(e)}")

if __name__ == "__main__":
    import asyncio
    import sys
    
    async def test_deploy():
        # Replace these with actual values for testing
        sandbox_id = "sandbox-ccb30b35"
        password = "test-password"
        
        # Initialize the deploy tool
        deploy_tool = SandboxDeployTool(sandbox_id, password)
        
        # Test deployment - replace with actual directory path and site name
        result = await deploy_tool.deploy(
            name="test-site-1x",
            directory_path="website"  # Directory containing static site files
        )
        print(f"Deployment result: {result}")
            
    asyncio.run(test_deploy())

