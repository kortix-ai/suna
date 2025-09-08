import json
import os
from typing import Optional, Dict, Any, List

from core.agentpress.tool import ToolResult, openapi_schema, usage_example
from core.agentpress.thread_manager import ThreadManager
from core.sandbox.tool_base import SandboxToolsBase
from core.utils.logger import logger


class SandboxTemplatesTool(SandboxToolsBase):
    """Tool to discover and scaffold web project templates."""

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.workspace_path = "/workspace"
        self.local_templates_dir = "/opt/templates"
        self.local_manifest = f"{self.local_templates_dir}/manifest.json"
        self.remote_manifest_url = os.getenv("TEMPLATES_MANIFEST_URL")
        self.remote_archive_base = os.getenv("TEMPLATES_ARCHIVE_BASE_URL")  # e.g. https://example.com/templates/{name}.zip

    async def _read_local_manifest(self) -> Optional[Dict[str, Any]]:
        await self._ensure_sandbox()
        try:
            check = await self.sandbox.process.exec(f"/bin/sh -c 'test -f {self.local_manifest} && echo OK || echo NO'", timeout=10)
            if "OK" not in (getattr(check, "result", "") or ""):
                return None
            content = await self.sandbox.fs.download_file(self.local_manifest)
            return json.loads(content.decode())
        except Exception:
            return None

    async def _fetch_remote_manifest(self) -> Optional[Dict[str, Any]]:
        await self._ensure_sandbox()
        if not self.remote_manifest_url:
            return None
        try:
            resp = await self.sandbox.process.exec(f"/bin/sh -c 'curl -fsSL {self.remote_manifest_url} -o /tmp/templates_manifest.json'", timeout=30)
            if getattr(resp, "exit_code", 1) != 0:
                return None
            content = await self.sandbox.fs.download_file("/tmp/templates_manifest.json")
            return json.loads(content.decode())
        except Exception:
            return None

    def _format_templates(self, manifest: Dict[str, Any]) -> List[Dict[str, Any]]:
        templates = manifest.get("templates", [])
        formatted: List[Dict[str, Any]] = []
        for t in templates:
            formatted.append({
                "name": t.get("name"),
                "description": t.get("description", ""),
                "tags": t.get("tags", []),
                "path": t.get("path"),
                "repo": t.get("repo"),
            })
        return formatted

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_templates",
            "description": "List available web project templates (prefers local manifest, falls back to remote).",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="list_templates" />
        </function_calls>
    ''')
    async def list_templates(self) -> ToolResult:
        try:
            await self._ensure_sandbox()
            manifest = await self._read_local_manifest()
            if not manifest:
                manifest = await self._fetch_remote_manifest()
            if not manifest:
                return self.fail_response("No templates manifest found locally or remotely.")
            return self.success_response({
                "templates": self._format_templates(manifest)
            })
        except Exception as e:
            logger.error(f"Error listing templates: {e}", exc_info=True)
            return self.fail_response(f"Error listing templates: {e}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "scaffold_from_template",
            "description": "Create a new project from a template. Prefers local /opt/templates/<name>, otherwise downloads {name}.zip from TEMPLATES_ARCHIVE_BASE_URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "template_name": {"type": "string"},
                    "project_name": {"type": "string"},
                    "package_manager": {"type": "string", "default": "pnpm"}
                },
                "required": ["template_name", "project_name"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="scaffold_from_template">
          <parameter name="template_name">next14-shadcn</parameter>
          <parameter name="project_name">webdemo</parameter>
          <parameter name="package_manager">pnpm</parameter>
        </invoke>
        </function_calls>
    ''')
    async def scaffold_from_template(self, template_name: str, project_name: str, package_manager: str = "pnpm") -> ToolResult:
        try:
            await self._ensure_sandbox()
            target_dir = f"{self.workspace_path}/{project_name}"
            # Ensure target doesn't exist
            exists = await self.sandbox.process.exec(f"/bin/sh -c 'test -e {target_dir} && echo EXISTS || echo NEW'", timeout=10)
            if "EXISTS" in (getattr(exists, "result", "") or ""):
                return self.fail_response(f"Target '{project_name}' already exists")

            local_path = f"{self.local_templates_dir}/{template_name}"
            local_ok = await self.sandbox.process.exec(f"/bin/sh -c 'test -d {local_path} && echo OK || echo NO'", timeout=10)
            if "OK" in (getattr(local_ok, "result", "") or ""):
                copy = await self.sandbox.process.exec(f"/bin/sh -c 'cp -R {local_path} {target_dir}'", timeout=120)
                if getattr(copy, "exit_code", 1) != 0:
                    return self.fail_response(f"Failed to copy local template: {getattr(copy, 'result', '')}")
            else:
                # Remote zip fallback
                if not self.remote_archive_base:
                    return self.fail_response("Template not found locally and TEMPLATES_ARCHIVE_BASE_URL is not set")
                zip_url = self.remote_archive_base.rstrip('/') + f"/{template_name}.zip"
                cmds = (
                    f"cd /tmp && rm -rf tmpl_{template_name} template.zip && "
                    f"curl -fsSL {zip_url} -o template.zip && "
                    f"mkdir -p tmpl_{template_name} && unzip -q template.zip -d tmpl_{template_name} && "
                    f"cp -R tmpl_{template_name}/* {target_dir}"
                )
                dl = await self.sandbox.process.exec(f"/bin/sh -c \"{cmds}\"", timeout=300)
                if getattr(dl, "exit_code", 1) != 0:
                    return self.fail_response(f"Failed to download template: {getattr(dl, 'result', '')}")

            # Install deps
            if package_manager == "pnpm":
                install = await self.sandbox.process.exec(f"/bin/sh -c 'cd {target_dir} && pnpm install --prefer-offline'", timeout=900)
            else:
                install = await self.sandbox.process.exec(f"/bin/sh -c 'cd {target_dir} && npm install --no-audit --no-fund --progress=false'", timeout=900)
            if getattr(install, "exit_code", 1) != 0:
                return self.fail_response(f"Dependency install failed: {getattr(install, 'result', '')}")

            return self.success_response({
                "message": f"Project '{project_name}' created from template '{template_name}'.",
                "project": project_name
            })
        except Exception as e:
            logger.error(f"Error scaffolding from template: {e}", exc_info=True)
            return self.fail_response(f"Error scaffolding from template: {e}") 