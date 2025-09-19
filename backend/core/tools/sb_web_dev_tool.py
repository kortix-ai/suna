import json
import asyncio
from typing import Optional, List, Dict, Any
from pathlib import Path
import time
from uuid import uuid4

from core.agentpress.tool import ToolResult, openapi_schema, usage_example
from core.agentpress.thread_manager import ThreadManager
from core.sandbox.tool_base import SandboxToolsBase
from core.utils.logger import logger


class SandboxWebDevTool(SandboxToolsBase):
    WORKSPACE_PATH = "/workspace"
    TEMPLATE_DIR = "/opt/templates/vite-react-template"
    DEFAULT_TIMEOUT = 60
    BUILD_TIMEOUT = 1800
    INSTALL_TIMEOUT = 900
    DEFAULT_DEV_PORT = 5173
    DEFAULT_PREVIEW_PORT = 4173

    def __init__(self, project_id: str, thread_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.thread_id = thread_id
        self._sessions: Dict[str, str] = {}
        self.workspace_path = self.WORKSPACE_PATH

    async def _ensure_session(self, session_name: str = "default") -> str:
        if session_name not in self._sessions:
            session_id = str(uuid4())
            try:
                await self._ensure_sandbox()
                await self.sandbox.process.create_session(session_id)
                self._sessions[session_name] = session_id
            except Exception as e:
                raise RuntimeError(f"Failed to create session: {str(e)}")
        return self._sessions[session_name]

    async def _execute_command(self, command: str, timeout: int = DEFAULT_TIMEOUT) -> Dict[str, Any]:
        session_id = await self._ensure_session("web_dev_commands")
        from daytona_sdk import SessionExecuteRequest
        
        req = SessionExecuteRequest(
            command=command,
            var_async=False,
            cwd=self.workspace_path
        )
        
        response = await self.sandbox.process.execute_session_command(
            session_id=session_id,
            req=req,
            timeout=timeout
        )
        
        logs = await self.sandbox.process.get_session_command_logs(
            session_id=session_id,
            command_id=response.cmd_id
        )
        
        return {
            "output": logs,
            "exit_code": response.exit_code
        }

    async def _exec_sh(self, command: str, timeout: int = DEFAULT_TIMEOUT) -> Dict[str, Any]:
        await self._ensure_sandbox()
        resp = await self.sandbox.process.exec(f"/bin/sh -c \"{command}\"", timeout=timeout)
        output = getattr(resp, "result", None) or getattr(resp, "output", "") or ""
        return {"exit_code": getattr(resp, "exit_code", 1), "output": output}

    async def _run_in_tmux_background(self, session: str, command: str) -> None:
        await self._ensure_sandbox()
        await self._exec_sh(f"tmux has-session -t {session} 2>/dev/null || tmux new-session -d -s {session}")
        escaped = command.replace('"', '\\"')
        await self._exec_sh(f"tmux send-keys -t {session} \"cd {self.workspace_path} && {escaped}\" C-m")

    def _get_project_path(self, project_name: str) -> str:
        return f"{self.workspace_path}/{project_name}"

    async def _project_exists(self, project_name: str) -> bool:
        check_result = await self._exec_sh(f"test -f {self._get_project_path(project_name)}/package.json && echo OK || echo MISS")
        return "OK" in check_result.get("output", "")

    async def _has_src_directory(self, project_path: str) -> bool:
        src_check = await self._exec_sh(f"test -d {project_path}/src && echo YES || echo NO")
        return "YES" in src_check.get("output", "")

    def _get_package_manager_command(self, package_manager: str, command_type: str, additional_args: str = "") -> str:
        commands = {
            "npm": {
                "install": f"npm install --no-audit --no-fund --progress=false {additional_args}",
                "add": f"npm install --save {additional_args}",
                "add_dev": f"npm install --save-dev {additional_args}",
                "build": "npm run build",
                "dev": "npm run dev",
                "preview": "npm run preview"
            }
        }
        return commands.get(package_manager, commands["npm"]).get(command_type, "")

    async def _has_template(self) -> bool:
        """Check if the Vite React template exists"""
        dir_check = await self._exec_sh(f"test -d {self.TEMPLATE_DIR} && echo EXISTS || echo MISSING")
        return "EXISTS" in dir_check.get("output", "")

    async def _copy_template(self, project_name: str) -> Dict[str, Any]:
        """Copy the Vite React template to create a new project"""
        try:
            if not await self._has_template():
                return {"success": False, "error": f"Template directory {self.TEMPLATE_DIR} not found"}
            
            project_path = self._get_project_path(project_name)
            
            # Copy template
            copy_cmd = f"cp -r {self.TEMPLATE_DIR} {project_path}"
            copy_result = await self._exec_sh(copy_cmd, timeout=60)
            
            if copy_result["exit_code"] != 0:
                return {"success": False, "error": f"Failed to copy template: {copy_result['output']}"}
            
            # Install dependencies in the new project
            install_cmd = f"cd {project_path} && npm install"
            install_result = await self._exec_sh(install_cmd, timeout=self.INSTALL_TIMEOUT)
            
            if install_result["exit_code"] != 0:
                return {"success": False, "error": f"Failed to install dependencies: {install_result['output']}"}
            
            return {"success": True, "message": f"Vite React project '{project_name}' created successfully from template"}
            
        except Exception as e:
            return {"success": False, "error": f"Exception copying template: {str(e)}"}

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_vite_react_project",
            "description": "Create a new Vite + React project with TypeScript, Tailwind CSS, and shadcn/ui setup from template.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_name": {
                        "type": "string", 
                        "description": "Name of the project to create"
                    }
                },
                "required": ["project_name"]
            }
        }
    })
    @usage_example('''
        <!-- Create a new Vite React project -->
        <function_calls>
        <invoke name="create_vite_react_project">
        <parameter name="project_name">my-react-app</parameter>

        </invoke>
        </function_calls>
        ''')
    async def create_vite_react_project(self, project_name: str) -> ToolResult:
        try:
            await self._ensure_sandbox()
            
            # Check if project already exists
            if await self._project_exists(project_name):
                return self.fail_response(f"Project '{project_name}' already exists")
            
            # Copy template to create the project
            copy_result = await self._copy_template(project_name)
            
            if not copy_result["success"]:
                return self.fail_response(copy_result["error"])
            
            project_path = self._get_project_path(project_name)
            
            # Show project structure
            structure_cmd = f"cd {project_path} && find . -maxdepth 3 -type f | grep -v node_modules | head -20"
            structure_result = await self._exec_sh(structure_cmd)
            
            success_message = f"""
            ✅ Vite React project '{project_name}' created successfully from template!

            📦 **Stack:** Vite + React + TypeScript + Tailwind CSS + shadcn/ui ready

            📁 **Project Structure:**
            {structure_result.get('output', 'Could not display structure')}

            🚀 **Next Steps:**
            1. Start development: Use start_dev_server tool
            2. Edit files in src/ folder
            3. Install components: Use generic command tool with `npx shadcn@latest add button`
            4. Build for production: Use build_project tool

            💡 **Template includes:** Tailwind CSS, shadcn/ui utils, and basic setup ready to go!
            """
            
            return self.success_response(success_message)
            
        except Exception as e:
            logger.error(f"Error creating Vite React project: {str(e)}", exc_info=True)
            return self.fail_response(f"Error creating project: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_project_structure",
            "description": "Get the file structure of a web project, showing important files and directories.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_name": {"type": "string", "description": "Name of the project directory to examine"},
                    "max_depth": {"type": "integer", "description": "Maximum depth to traverse (default: 3)", "default": 3}
                },
                "required": ["project_name"]
            }
        }
    })
    @usage_example('''
        <!-- Get structure of a project -->
        <function_calls>
        <invoke name="get_project_structure">
        <parameter name="project_name">my-app</parameter>
        </invoke>
        </function_calls>
        ''')
    async def get_project_structure(self, project_name: str, max_depth: int = 3) -> ToolResult:
        try:
            await self._ensure_sandbox()
            project_path = self._get_project_path(project_name)
            
            check_cmd = f"test -d {project_path} && echo '__DIR_EXISTS__' || echo '__DIR_MISSING__'"
            check_result = await self._execute_command(check_cmd)
            
            if "__DIR_MISSING__" in check_result.get("output", ""):
                return self.fail_response(f"Project '{project_name}' not found.")

            tree_cmd = (
                f"cd {project_path} && find . -maxdepth {max_depth} -type f -o -type d | "
                "grep -v node_modules | grep -v '\\.git' | grep -v 'dist' | sort"
            )
            tree_result = await self._execute_command(tree_cmd)
            
            if tree_result.get("exit_code") != 0:
                return self.fail_response(f"Failed to get project structure: {tree_result.get('output')}")

            structure = tree_result.get("output", "")

            package_info = ""
            package_cmd = f"test -f {project_path}/package.json && cat {project_path}/package.json | grep -E '\"(name|version|scripts)\"' -A 5 | head -20"
            package_result = await self._execute_command(package_cmd)
            
            if package_result.get("exit_code") == 0:
                package_info = f"\n\n📋 Package.json info:\n{package_result.get('output', '')}"

            return self.success_response(f"""
            📁 Project structure for '{project_name}':

            {structure}
            {package_info}

            To run this project:
            1. Use install_dependencies if needed
            2. Use start_dev_server for development
            3. Use build_project then start_preview_server for production preview
            4. Use expose_port to make it publicly accessible
""")

        except Exception as e:
            logger.error(f"Error getting project structure: {str(e)}", exc_info=True)
            return self.fail_response(f"Error getting project structure: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "build_project",
            "description": "Run production build for the project.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_name": {"type": "string"},
                    "package_manager": {"type": "string", "default": "npm"}
                },
                "required": ["project_name"]
            }
        }
    })
    @usage_example('''
        <!-- Build a Vite React project for production -->
        <function_calls>
        <invoke name="build_project">
        <parameter name="project_name">my-app</parameter>
        <parameter name="package_manager">npm</parameter>
        </invoke>
        </function_calls>
        ''')
    async def build_project(self, project_name: str, package_manager: str = "npm") -> ToolResult:
        try:
            await self._ensure_sandbox()
            
            if not await self._project_exists(project_name):
                return self.fail_response(f"Project '{project_name}' not found")

            proj_dir = self._get_project_path(project_name)
            cmd = self._get_package_manager_command(package_manager, "build")
            
            res = await self._exec_sh(f"cd {proj_dir} && {cmd}", timeout=self.BUILD_TIMEOUT)
            
            if res["exit_code"] != 0:
                return self.fail_response(f"Build failed: {res['output']}")
            
            return self.success_response(f"Build completed for '{project_name}'.")

        except Exception as e:
            logger.error(f"Error building project: {e}", exc_info=True)
            return self.fail_response(f"Error building project: {e}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "start_dev_server",
            "description": "Start the Vite development server for a project.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_name": {"type": "string"},
                    "package_manager": {"type": "string", "default": "npm"},
                    "port": {"type": "integer", "default": 5173}
                },
                "required": ["project_name"]
            }
        }
    })
    @usage_example('''
        <!-- Start development server -->
        <function_calls>
        <invoke name="start_dev_server">
        <parameter name="project_name">my-app</parameter>
        <parameter name="port">5173</parameter>
        </invoke>
        </function_calls>
        ''')
    async def start_dev_server(self, project_name: str, package_manager: str = "npm", port: int = 5173) -> ToolResult:
        try:
            await self._ensure_sandbox()
            
            if not await self._project_exists(project_name):
                return self.fail_response(f"Project '{project_name}' not found")

            project_path = self._get_project_path(project_name)
            session_name = f"dev_{project_name}"
            
            # Start dev server in background using tmux
            dev_cmd = f"{self._get_package_manager_command(package_manager, 'dev')} --host 0.0.0.0 --port {port}"
            await self._run_in_tmux_background(session_name, f"cd {project_path} && {dev_cmd}")
            
            # Wait a moment for server to start
            await asyncio.sleep(3)
            
            return self.success_response(f"""
🚀 Development server started for '{project_name}'!

📍 **Server Details:**
- Port: {port}
- Session: {session_name}
- URL: http://localhost:{port}

⚡ **Vite Features Active:**
- Hot Module Replacement (HMR)
- TypeScript support
- Fast refresh

🔧 **Next Steps:**
1. Use expose_port tool with port {port} to make it publicly accessible
2. Edit files in src/ and see changes instantly
3. Install shadcn components: `npx shadcn@latest add button card`

💡 **Server is running in background session '{session_name}'**
""")

        except Exception as e:
            logger.error(f"Error starting dev server: {e}", exc_info=True)
            return self.fail_response(f"Error starting dev server: {e}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "start_preview_server",
            "description": "Start the Vite preview server to serve the built production files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_name": {"type": "string"},
                    "package_manager": {"type": "string", "default": "npm"},
                    "port": {"type": "integer", "default": 4173}
                },
                "required": ["project_name"]
            }
        }
    })
    @usage_example('''
        <!-- Start preview server after building -->
        <function_calls>
        <invoke name="start_preview_server">
        <parameter name="project_name">my-app</parameter>
        <parameter name="port">4173</parameter>
        </invoke>
        </function_calls>
        ''')
    async def start_preview_server(self, project_name: str, package_manager: str = "npm", port: int = 4173) -> ToolResult:
        try:
            await self._ensure_sandbox()
            
            if not await self._project_exists(project_name):
                return self.fail_response(f"Project '{project_name}' not found")

            project_path = self._get_project_path(project_name)
            
            # Check if build exists
            dist_check = await self._exec_sh(f"test -d {project_path}/dist && echo EXISTS || echo MISSING")
            if "MISSING" in dist_check.get("output", ""):
                return self.fail_response(f"No build found for '{project_name}'. Run build_project first.")
            
            session_name = f"preview_{project_name}"
            
            # Start preview server in background using tmux
            preview_cmd = f"{self._get_package_manager_command(package_manager, 'preview')} --host 0.0.0.0 --port {port}"
            await self._run_in_tmux_background(session_name, f"cd {project_path} && {preview_cmd}")
            
            # Wait a moment for server to start
            await asyncio.sleep(3)
            
            return self.success_response(f"""
🎯 Preview server started for '{project_name}'!

📍 **Production Preview:**
- Port: {port}
- Session: {session_name}
- URL: http://localhost:{port}

📦 **Serving optimized build:**
- Minified assets
- Production performance
- Optimized bundle sizes

🔧 **Next Steps:**
1. Use expose_port tool with port {port} to make it publicly accessible
2. Test production performance and functionality

💡 **Server is running in background session '{session_name}'**
""")

        except Exception as e:
            logger.error(f"Error starting preview server: {e}", exc_info=True)
            return self.fail_response(f"Error starting preview server: {e}")

