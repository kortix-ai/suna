import re
import shlex
import asyncio
import httpx

from core.agentpress.tool import tool_metadata, openapi_schema, ToolResult
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
from core.services.http_client import get_http_client
from core.credentials.profile_service import ProfileService


@tool_metadata(
    display_name="CodebaseSearch",
    description="AI-powered codebase search that finds relevant code spans across your project",
    icon="Search",
    color="bg-purple-100 dark:bg-purple-800/50",
    weight=35,
    visible=True,
    usage_guide="""## Codebase Search Tool

AI-powered codebase search using WarpGrep. Finds relevant code spans across your project.

### Functions
- `codebase_search(query, path?)` - Search for code patterns, function definitions, usage examples

### When to Use
- Finding function/class definitions across a codebase
- Understanding how a feature is implemented
- Locating all usages of an API or pattern
- Navigating unfamiliar codebases

### Examples
```
codebase_search(query="authentication middleware", path="src/")
codebase_search(query="how are database migrations handled")
codebase_search(query="React component for user profile")
```

### Notes
- Requires a Morph API key (user must configure via Settings > API Keys)
- Searches within the sandbox workspace
- Returns specific file spans with line numbers
- More effective than grep for semantic code queries
"""
)
class WarpGrepTool(SandboxToolsBase):
    """AI-powered codebase search using the WarpGrep API."""

    _MAX_TURNS = 4

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self._api_key = None

    async def _resolve_api_key(self) -> str | None:
        if self._api_key:
            return self._api_key
        try:
            account_id = self.thread_manager.account_id
            db = self.thread_manager.db
            if not account_id or not db:
                return None
            profile_service = ProfileService(db)
            profile = await profile_service.get_default_profile(account_id, "morph")
            if profile and profile.config:
                self._api_key = profile.config.get('api_key')
        except Exception as e:
            logger.error(f"Failed to load Morph credential profile: {e}")
        return self._api_key

    def _validate_path(self, path: str) -> str | None:
        if '..' in path.split('/'):
            return None
        if path.startswith('/'):
            return None
        return path

    def _validate_ranges(self, ranges_str: str) -> list[tuple[str, str]] | None:
        parsed = []
        for part in ranges_str.split(","):
            part = part.strip()
            if not part:
                continue
            if not re.match(r'^\d+(-\d+)?$', part):
                return None
            if "-" in part:
                start, end = part.split("-", 1)
                parsed.append((start, end))
            else:
                parsed.append((part, part))
        return parsed if parsed else None

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "codebase_search",
            "description": "Search the codebase for relevant code using AI-powered search. Returns specific file spans with line numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language description of what you're looking for (e.g. 'authentication middleware', 'database connection setup')"
                    },
                    "path": {
                        "type": "string",
                        "description": "Optional subdirectory to scope the search (e.g. 'src/', 'backend/core/'). Defaults to workspace root.",
                        "default": "."
                    }
                },
                "required": ["query"],
                "additionalProperties": False
            }
        }
    })
    async def codebase_search(self, query: str, path: str = ".") -> ToolResult:
        """Search the codebase for relevant code spans using the WarpGrep API."""
        api_key = await self._resolve_api_key()
        if not api_key:
            return self.fail_response(
                "Morph API key not configured. Add your Morph API key in "
                "Settings > API Keys to use codebase search."
            )

        try:
            path = self._validate_path(path) or "."
            await self._ensure_sandbox()

            repo_structure = await self._get_repo_structure(path)
            initial_message = (
                f"<repo_structure>{repo_structure}</repo_structure>"
                f"<search_string>{query}</search_string>"
            )
            messages = [{"role": "user", "content": initial_message}]
            file_spans = None

            for turn in range(self._MAX_TURNS):
                response = await self._call_warpgrep_api(messages, api_key)
                if not response:
                    return self.fail_response("WarpGrep API returned empty response")

                assistant_content = response.get("content", "")
                messages.append({"role": "assistant", "content": assistant_content})

                tool_calls = self._parse_xml_tool_calls(assistant_content)
                if not tool_calls:
                    break

                tool_results = []
                for tc in tool_calls:
                    if tc["name"] == "finish":
                        file_spans = tc["args"].get("file_spans", "")
                        break
                    result = await self._execute_tool_call(tc)
                    tool_results.append(result)

                if file_spans is not None:
                    break

                tool_response = "\n".join(
                    f"<tool_response>{r}</tool_response>" for r in tool_results
                )
                budget_msg = f"\n\n[Turn {turn + 2} of {self._MAX_TURNS}]"
                messages.append({"role": "user", "content": tool_response + budget_msg})

            if not file_spans:
                return self.success_response({
                    "message": "No relevant code found for the query.",
                    "query": query,
                    "results": []
                })

            results = await self._read_file_spans(file_spans)
            return self.success_response({
                "query": query,
                "results": results
            })

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 401:
                self._api_key = None
                return self.fail_response(
                    "Invalid Morph API key. Update your key in Settings > API Keys."
                )
            logger.error(f"codebase_search HTTP error: {e}")
            return self.fail_response(f"Codebase search failed: {str(e)[:200]}")
        except Exception as e:
            logger.error(f"codebase_search error: {e}")
            return self.fail_response(f"Codebase search failed: {str(e)[:200]}")

    async def _get_repo_structure(self, path: str) -> str:
        safe_path = shlex.quote(f"{self.workspace_path}/{path}".rstrip("/"))
        result = await self.sandbox.process.exec(
            f"find {safe_path} -type f "
            f"-not -path '*/\\.*' -not -path '*/node_modules/*' "
            f"-not -path '*/__pycache__/*' -not -path '*/venv/*' "
            f"-not -path '*/.git/*' -not -path '*/dist/*' "
            f"-not -path '*/build/*' -not -path '*/.next/*' "
            f"| head -500",
            timeout=30
        )
        if result.exit_code != 0:
            return ""
        prefix = self.workspace_path + "/"
        return "\n".join(line.removeprefix(prefix) for line in result.result.strip().splitlines())

    async def _call_warpgrep_api(self, messages: list, api_key: str) -> dict | None:
        async with get_http_client() as client:
            response = await client.post(
                "https://api.morphllm.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": "morph-warp-grep-v2",
                    "messages": messages,
                    "temperature": 0.0,
                    "max_tokens": 2048
                },
            )
            response.raise_for_status()
            data = response.json()
            choices = data.get("choices", [])
            if choices:
                return choices[0].get("message", {})
        return None

    def _parse_xml_tool_calls(self, content: str) -> list[dict]:
        tool_calls = []
        for match in re.finditer(
            r"<(ripgrep|read|list_directory|finish)>(.*?)</\1>", content, re.DOTALL
        ):
            args = self._parse_tool_args(match.group(2).strip())
            tool_calls.append({"name": match.group(1), "args": args})
        return tool_calls

    def _parse_tool_args(self, content: str) -> dict:
        args = {}
        for match in re.finditer(r"<(\w+)>(.*?)</\1>", content, re.DOTALL):
            args[match.group(1)] = match.group(2).strip()
        return args

    async def _execute_tool_call(self, tool_call: dict) -> str:
        name = tool_call["name"]
        args = tool_call["args"]
        cwd = self.workspace_path

        if name == "ripgrep":
            pattern = args.get("pattern", "")
            glob_filter = args.get("glob", "")
            glob_arg = f"--glob {shlex.quote(glob_filter)} " if glob_filter else ""
            cmd = (
                f"rg --line-number --no-heading {glob_arg}"
                f"-- {shlex.quote(pattern)} {shlex.quote(cwd)} | head -100"
            )
            result = await self.sandbox.process.exec(cmd, timeout=30)
            return result.result.strip() if result.exit_code == 0 else "No matches found"

        elif name == "read":
            file_path = self._validate_path(args.get("path", ""))
            if not file_path:
                return "Invalid file path"
            full_path = f"{cwd}/{file_path}"
            line_ranges = args.get("lines", "")
            if line_ranges:
                parsed_ranges = self._validate_ranges(line_ranges)
                if not parsed_ranges:
                    return "Invalid line range format"
                sed_ranges = [f"{s},{e}p" for s, e in parsed_ranges]
                sed_expr = ";".join(sed_ranges)
                cmd = f"sed -n {shlex.quote(sed_expr)} {shlex.quote(full_path)} | cat -n"
            else:
                cmd = f"cat -n {shlex.quote(full_path)} | head -200"
            result = await self.sandbox.process.exec(cmd, timeout=30)
            return result.result.strip() if result.exit_code == 0 else f"Could not read: {file_path}"

        elif name == "list_directory":
            dir_path = self._validate_path(args.get("path", ".")) or "."
            full_path = f"{cwd}/{dir_path}"
            result = await self.sandbox.process.exec(
                f"ls -la {shlex.quote(full_path)} | head -50", timeout=15
            )
            return result.result.strip() if result.exit_code == 0 else f"Could not list: {dir_path}"

        return f"Unknown tool: {name}"

    async def _read_file_spans(self, file_spans_str: str) -> list[dict]:
        cwd = self.workspace_path

        async def read_span(spec: str) -> dict | None:
            if ":" not in spec:
                return None
            file_path, ranges_str = spec.split(":", 1)
            file_path = self._validate_path(file_path.strip())
            if not file_path:
                return None
            parsed_ranges = self._validate_ranges(ranges_str)
            if not parsed_ranges:
                return None
            full_path = f"{cwd}/{file_path}"
            sed_ranges = [f"{s},{e}p" for s, e in parsed_ranges]
            sed_expr = ";".join(sed_ranges)
            result = await self.sandbox.process.exec(
                f"sed -n {shlex.quote(sed_expr)} {shlex.quote(full_path)}", timeout=15
            )
            if result.exit_code == 0 and result.result.strip():
                return {
                    "file": file_path,
                    "ranges": ranges_str,
                    "content": result.result.strip()
                }
            return None

        specs = [s.strip() for s in file_spans_str.split("\n") if s.strip()]
        span_results = await asyncio.gather(*[read_span(s) for s in specs])
        return [r for r in span_results if r is not None]
