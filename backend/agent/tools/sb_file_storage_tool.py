from agentpress.tool import ToolResult, openapi_schema, xml_schema
from sandbox.sandbox import SandboxToolsBase
from agentpress.thread_manager import ThreadManager
from datetime import datetime
import json
import uuid

class FileStorageTool(SandboxToolsBase):
    """Tool for storing and retrieving data as files within the Daytona sandbox under /workspace/agent_storage."""

    def __init__(
        self,
        project_id: str,
        thread_manager: ThreadManager
    ):
        super().__init__(project_id, thread_manager)

        self.workspace_path = "/workspace"
        self.storage_base  = f"{self.workspace_path}/agent_storage"
        self.scrape_dir    = f"{self.storage_base}/scrapes"
        self.search_dir    = f"{self.storage_base}/searches"
        self.data_dir      = f"{self.storage_base}/data"

        self._dirs_initialized = False

    async def _ensure_dirs(self):
        """Ensure sandbox is initialized and storage directories exist."""
        if self._dirs_initialized:
            return
        await self._ensure_sandbox()
        for path in [self.storage_base, self.scrape_dir, self.search_dir, self.data_dir]:
            self.sandbox.fs.create_folder(path, "755")
        self._dirs_initialized = True

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "store_file",
            "description": "Store content as .txt in the sandbox and return the filename.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string"},
                    "file_type": {"type": "string", "enum":["scrape","search","data"], "default":"data"},
                    "file_name": {"type": "string"},
                    "metadata": {"type":"object"}
                },
                "required":["content"]
            }
        }
    })
    @xml_schema(
        tag_name="store-file",
        mappings=[
            {"param_name":"content","node_type":"text","path":"."},
            {"param_name":"file_type","node_type":"attribute","path":"."},
            {"param_name":"file_name","node_type":"attribute","path":"."},
            {"param_name":"metadata","node_type":"element","path":"metadata"}
        ]
    )
    async def store_file(
        self,
        content: str,
        file_type: str = "data",
        file_name: str = None,
        metadata: dict = None
    ) -> ToolResult:
        await self._ensure_dirs()

        dir_map = {"scrape": self.scrape_dir, "search": self.search_dir, "data": self.data_dir}
        directory = dir_map.get(file_type, self.data_dir)

        if not file_name:
            stamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
            uid = uuid.uuid4().hex[:8]
            file_name = f"{file_type}_{stamp}_{uid}.txt"
        elif not file_name.endswith('.txt'):
            file_name += '.txt'

        full_path = f"{directory}/{file_name}"
        self.sandbox.fs.upload_file(full_path, content.encode('utf-8'))

        result = {"file_name": file_name, "file_path": full_path}
        if metadata:
            meta_path = full_path + '.meta.json'
            self.sandbox.fs.upload_file(meta_path, json.dumps(metadata, indent=2).encode('utf-8'))
            result['has_metadata'] = True

        return self.success_response(result)

    @openapi_schema({
        "type":"function",
        "function":{
            "name":"read_file",
            "description":"Read a .txt file from the sandbox, optionally including metadata.",
            "parameters":{
                "type":"object",
                "properties":{
                    "file_name":{"type":"string"},
                    "file_type":{"type":"string","enum":["scrape","search","data"],"default":"data"},
                    "include_metadata":{"type":"boolean","default":True}
                },
                "required":["file_name"]
            }
        }
    })
    @xml_schema(
        tag_name="read-file",
        mappings=[
            {"param_name":"file_name","node_type":"attribute","path":"."},
            {"param_name":"file_type","node_type":"attribute","path":"."},
            {"param_name":"include_metadata","node_type":"attribute","path":"."}
        ]
    )
    async def read_file(
        self,
        file_name: str,
        file_type: str = "data",
        include_metadata: bool = True
    ) -> ToolResult:
        await self._ensure_dirs()

        dir_map = {"scrape": self.scrape_dir, "search": self.search_dir, "data": self.data_dir}
        directory = dir_map.get(file_type, self.data_dir)

        if not file_name.endswith('.txt'):
            file_name += '.txt'
        full_path = f"{directory}/{file_name}"
        try:
            raw = self.sandbox.fs.download_file(full_path)
        except Exception:
            return self.fail_response(f"File not found: {file_name}")

        content = raw.decode('utf-8', errors='replace')
        output = {"file_name": file_name, "content": content}
        if include_metadata:
            meta_path = full_path + '.meta.json'
            try:
                meta_raw = self.sandbox.fs.download_file(meta_path)
                output['metadata'] = json.loads(meta_raw.decode('utf-8'))
            except Exception:
                pass
        return self.success_response(output)

    @openapi_schema({
        "type":"function",
        "function":{
            "name":"list_files",
            "description":"List stored .txt files by type.",
            "parameters":{
                "type":"object",
                "properties":{
                    "file_type":{"type":"string","enum":["scrape","search","data","all"],"default":"all"}
                }
            }
        }
    })
    @xml_schema(tag_name="list-files", mappings=[{"param_name":"file_type","node_type":"attribute","path":"."}])
    async def list_files(self, file_type: str = "all") -> ToolResult:
        await self._ensure_dirs()

        out = {}
        if file_type in ("scrape", "all"):
            files = self.sandbox.fs.list_files(self.scrape_dir)
            out['scrape_files'] = [f.name for f in files if f.name.endswith('.txt')]
        if file_type in ("search", "all"):
            files = self.sandbox.fs.list_files(self.search_dir)
            out['search_files'] = [f.name for f in files if f.name.endswith('.txt')]
        if file_type in ("data", "all"):
            files = self.sandbox.fs.list_files(self.data_dir)
            out['data_files'] = [f.name for f in files if f.name.endswith('.txt')]
        return self.success_response(out)
