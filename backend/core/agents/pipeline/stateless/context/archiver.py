import asyncio
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, Any, List

from core.utils.logger import logger


@dataclass
class RetrievalHint:
    topic: str
    keywords: List[str]
    message_range: str


@dataclass
class ArchiveResult:
    batch_number: int
    summary_path: str
    summary: str
    retrieval_hints: List[RetrievalHint]
    message_count: int
    tool_results_count: int
    tokens_archived: int
    key_facts: Dict[str, Any] = field(default_factory=dict)
    full_summary_content: str = ""


class ContextArchiver:
    """
    Archives conversation messages to sandbox filesystem for on-demand retrieval.

    Structure:
    /workspace/.kortix/context/
      manifest.json
      summaries/
        batch_001.md                    # Small summary (~500 tokens)
      messages/
        batch_001/
          MSG-001_user.md               # Individual messages
          MSG-002_assistant.md
          MSG-003_tool.md               # Tool results
          ...
    """

    BASE_DIR = ".kortix/context"
    WORKSPACE_PATH = "/workspace"

    def __init__(self, project_id: str, account_id: str, thread_id: str, db_client=None):
        self.project_id = project_id
        self.account_id = account_id
        self.thread_id = thread_id
        self.db_client = db_client

    async def archive_messages(
        self,
        messages: List[Dict[str, Any]],
        model: str = "openrouter/openai/gpt-5-mini",
        previous_summary: str = None
    ) -> ArchiveResult:
        """Archive messages to sandbox filesystem with per-file structure."""
        from core.sandbox.resolver import resolve_sandbox
        sandbox_info = await resolve_sandbox(
            self.project_id,
            self.account_id,
            self.db_client
        )

        if not sandbox_info:
            raise RuntimeError(f"Could not resolve sandbox for project {self.project_id}")

        sandbox = sandbox_info.sandbox

        # Get current manifest (also tells us if dirs exist)
        manifest = await self._get_manifest(sandbox)

        # Only create directories on first batch (manifest has no batches yet)
        if not manifest.get("batches"):
            await self._ensure_directories(sandbox)

        # Determine batch number
        batch_number = len(manifest.get("batches", [])) + 1

        # Write individual message and tool result files
        total_before = manifest.get("total_archived", 0)

        # Run file writes and LLM summary in parallel
        file_write_task = self._write_message_files(sandbox, messages, batch_number, total_before)
        summary_task = self._generate_summary(messages, batch_number, model, previous_summary)
        tool_results_written, summary_data = await asyncio.gather(file_write_task, summary_task)

        # Write summary file + update manifest in parallel
        summary_path = f"{self.WORKSPACE_PATH}/{self.BASE_DIR}/summaries/batch_{batch_number:03d}.md"
        summary_content = self._format_summary_file(batch_number, messages, summary_data, tool_results_written, total_before)

        retrieval_hints = self._build_retrieval_hints(summary_data, batch_number, len(messages))
        tokens_archived = sum(len(str(m.get('content', ''))) // 4 for m in messages)

        await asyncio.gather(
            sandbox.fs.upload_file(summary_content.encode('utf-8'), summary_path),
            self._update_manifest(
                sandbox=sandbox,
                manifest=manifest,
                batch_number=batch_number,
                message_count=len(messages),
                tool_results=list(tool_results_written.keys()),
                topics=summary_data.get("topics", []),
                key_facts=summary_data.get("facts", {})
            )
        )

        logger.info(f"[ContextArchiver] Wrote batch {batch_number}: {len(messages)} messages, {len(tool_results_written)} tool results")

        return ArchiveResult(
            batch_number=batch_number,
            summary_path=summary_path,
            summary=summary_data.get("summary", ""),
            retrieval_hints=retrieval_hints,
            message_count=len(messages),
            tool_results_count=len(tool_results_written),
            tokens_archived=tokens_archived,
            key_facts=summary_data.get("facts", {}),
            full_summary_content=summary_content,
        )

    async def _ensure_directories(self, sandbox) -> None:
        """Create archive directories if they don't exist."""
        dirs = [
            f"{self.WORKSPACE_PATH}/{self.BASE_DIR}",
            f"{self.WORKSPACE_PATH}/{self.BASE_DIR}/summaries",
            f"{self.WORKSPACE_PATH}/{self.BASE_DIR}/messages",
        ]
        for d in dirs:
            try:
                await sandbox.fs.create_folder(d, "755")
            except Exception:
                pass  # May already exist

    async def _get_manifest(self, sandbox) -> Dict[str, Any]:
        """Get or create manifest.json."""
        manifest_path = f"{self.WORKSPACE_PATH}/{self.BASE_DIR}/manifest.json"
        try:
            content = await sandbox.fs.download_file(manifest_path)
            return json.loads(content.decode('utf-8'))
        except Exception:
            return {
                "thread_id": self.thread_id,
                "total_archived": 0,
                "batches": [],
                "key_facts": {}
            }

    async def _update_manifest(
        self,
        sandbox,
        manifest: Dict[str, Any],
        batch_number: int,
        message_count: int,
        tool_results: List[str],
        topics: List[str],
        key_facts: Dict[str, Any]
    ) -> None:
        """Update manifest with new batch info."""
        total_before = manifest.get("total_archived", 0)

        manifest["batches"].append({
            "batch": batch_number,
            "messages": f"{total_before + 1}-{total_before + message_count}",
            "message_count": message_count,
            "tool_results": tool_results,
            "topics": topics,
            "archived_at": datetime.now(timezone.utc).isoformat()
        })

        manifest["total_archived"] = total_before + message_count

        # Merge key facts
        existing_facts = manifest.get("key_facts", {})
        for key, value in key_facts.items():
            if value:
                existing_facts[key] = value
        manifest["key_facts"] = existing_facts

        manifest_path = f"{self.WORKSPACE_PATH}/{self.BASE_DIR}/manifest.json"
        await sandbox.fs.upload_file(
            json.dumps(manifest, indent=2).encode('utf-8'),
            manifest_path
        )

    async def _write_message_files(
        self,
        sandbox,
        messages: List[Dict[str, Any]],
        batch_number: int,
        total_before: int = 0
    ) -> Dict[str, str]:
        """Write individual message files and tool result files. Returns tool_call_id -> filename mapping."""
        # Create batch message directory
        batch_dir = f"{self.WORKSPACE_PATH}/{self.BASE_DIR}/messages/batch_{batch_number:03d}"
        try:
            await sandbox.fs.create_folder(batch_dir, "755")
        except Exception:
            pass

        tool_results_written = {}
        upload_tasks = []

        for i, msg in enumerate(messages, 1):
            global_num = total_before + i
            role = msg.get('role', 'unknown')

            # Prepare message file
            filename = f"MSG-{global_num:03d}_{role}.md"
            filepath = f"{batch_dir}/{filename}"
            msg_content = self._format_message_file(global_num, msg)
            upload_tasks.append(sandbox.fs.upload_file(msg_content.encode('utf-8'), filepath))

            # Track tool results for summary reference
            if role == 'tool':
                tool_call_id = msg.get('tool_call_id', '')
                if tool_call_id:
                    tool_results_written[tool_call_id] = filename

            # Extract tool calls from assistant messages and note them
            if role == 'assistant':
                tool_calls = msg.get('tool_calls', [])
                for tc in tool_calls:
                    tc_id = tc.get('id', '')
                    if tc_id:
                        tool_results_written[tc_id] = f"MSG-{global_num:03d}_assistant.md"

        # Upload all files in parallel
        if upload_tasks:
            await asyncio.gather(*upload_tasks)

        return tool_results_written

    def _format_message_file(self, msg_num: int, msg: Dict[str, Any]) -> str:
        """Format a single message as markdown."""
        role = msg.get('role', 'unknown').upper()
        content = msg.get('content', '')

        lines = [
            f"# MSG-{msg_num:03d} [{role}]",
            f"Archived: {datetime.now(timezone.utc).isoformat()}",
            "",
            "---",
            ""
        ]

        # Handle content
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    if block.get('type') == 'text':
                        lines.append(block.get('text', ''))
                    elif block.get('type') == 'tool_use':
                        lines.append(f"**Tool Call:** {block.get('name')}")
                        lines.append(f"**Tool ID:** {block.get('id', 'unknown')}")
                        if block.get('input'):
                            lines.append("**Input:**")
                            lines.append(f"```json\n{json.dumps(block['input'], indent=2)}\n```")
                    elif block.get('type') == 'tool_result':
                        lines.append(f"**Tool Result:**")
                        lines.append(f"```\n{block.get('content', '')}\n```")
                lines.append("")
        elif isinstance(content, dict):
            lines.append(f"```json\n{json.dumps(content, indent=2)}\n```")
        else:
            lines.append(str(content))

        # Add tool calls if present
        tool_calls = msg.get('tool_calls', [])
        if tool_calls:
            lines.append("")
            lines.append("## Tool Calls")
            for tc in tool_calls:
                tc_id = tc.get('id', 'unknown')
                func = tc.get('function', {})
                name = func.get('name', 'unknown')
                args = func.get('arguments', '{}')
                lines.append(f"- **{name}** (id: `{tc_id}`)")
                try:
                    args_parsed = json.loads(args) if isinstance(args, str) else args
                    # Truncate large args
                    args_str = json.dumps(args_parsed, indent=2)
                    if len(args_str) > 500:
                        args_str = args_str[:500] + "\n... (truncated)"
                    lines.append(f"```json\n{args_str}\n```")
                except Exception:
                    lines.append(f"```\n{args}\n```")

        return "\n".join(lines)

    def _format_tool_result_file(self, msg: Dict[str, Any]) -> str:
        """Format a tool result as markdown."""
        tool_call_id = msg.get('tool_call_id', 'unknown')
        tool_name = msg.get('name', 'unknown')
        content = msg.get('content', '')

        lines = [
            f"# Tool Result: {tool_name}",
            f"Tool Call ID: `{tool_call_id}`",
            f"Archived: {datetime.now(timezone.utc).isoformat()}",
            "",
            "---",
            "",
            "## Output",
            ""
        ]

        if isinstance(content, str):
            # Try to parse as JSON for better formatting
            try:
                parsed = json.loads(content)
                lines.append(f"```json\n{json.dumps(parsed, indent=2)}\n```")
            except Exception:
                lines.append(f"```\n{content}\n```")
        else:
            lines.append(f"```json\n{json.dumps(content, indent=2)}\n```")

        return "\n".join(lines)

    def _format_summary_file(
        self,
        batch_number: int,
        messages: List[Dict[str, Any]],
        summary_data: Dict[str, Any],
        tool_results: Dict[str, str],
        total_before: int = 0
    ) -> str:
        """Format the summary file with conversation flow and references."""
        timestamp = datetime.now(timezone.utc).isoformat()
        topics = ", ".join(summary_data.get("topics", ["general"]))
        msg_start = total_before + 1
        msg_end = total_before + len(messages)

        lines = [
            f"# Batch {batch_number:03d} Summary",
            f"Messages: {msg_start}-{msg_end} | Archived: {timestamp}",
            f"Topics: {topics}",
            "",
            "## Summary",
            summary_data.get("summary", "No summary available."),
            ""
        ]

        # Key facts
        facts = summary_data.get("facts", {})
        if facts:
            lines.append("## Key Facts")
            if facts.get("project_name"):
                lines.append(f"- Project: {facts['project_name']}")
            if facts.get("tech_stack"):
                lines.append(f"- Stack: {', '.join(facts['tech_stack'][:5])}")
            if facts.get("current_goal"):
                lines.append(f"- Goal: {facts['current_goal']}")
            if facts.get("user_preferences"):
                prefs = facts["user_preferences"]
                if isinstance(prefs, list):
                    lines.append(f"- Preferences: {', '.join(prefs[:3])}")
            lines.append("")

        # Preserve user requests so original intent is never lost from archives
        user_messages = [
            m for m in messages
            if m.get('role') == 'user' and not m.get('_is_summary_inline')
        ]
        if user_messages:
            lines.append("## User Requests")
            for req_i, msg in enumerate(user_messages, 1):
                req_content = msg.get('content', '')
                if isinstance(req_content, list):
                    text_parts = [
                        b.get('text', '') for b in req_content
                        if isinstance(b, dict) and b.get('type') == 'text'
                    ]
                    req_content = '\n'.join(text_parts)
                req_content = str(req_content)[:2000]
                lines.append(f"### Request {req_i}")
                lines.append(req_content)
                lines.append("")

        # Key decisions
        if summary_data.get("key_decisions"):
            lines.append("## Key Decisions")
            for decision in summary_data["key_decisions"]:
                lines.append(f"- **{decision.get('decision', '')}**")
                if decision.get('rationale'):
                    lines.append(f"  - {decision['rationale']}")
            lines.append("")

        # Conversation flow with references
        lines.append("## Conversation Flow")
        for i, msg in enumerate(messages, 1):
            global_num = total_before + i
            role = msg.get('role', 'unknown')
            content = msg.get('content', '')

            # Get short preview of content (longer for user messages to preserve intent)
            preview_limit = 500 if role == 'user' else 80
            if isinstance(content, str):
                preview = content[:preview_limit].replace('\n', ' ')
                if len(content) > preview_limit:
                    preview += "..."
            elif isinstance(content, list):
                # Extract text from content blocks
                texts = [b.get('text', '')[:40] for b in content if isinstance(b, dict) and b.get('type') == 'text']
                preview = ' '.join(texts)[:80] or "[complex content]"
            else:
                preview = "[complex content]"

            # Add tool call references
            tool_ref = ""
            tool_calls = msg.get('tool_calls', [])
            if tool_calls:
                tc_names = [tc.get('function', {}).get('name', '?') for tc in tool_calls]
                tc_ids = [tc.get('id', '') for tc in tool_calls]
                tool_ref = f" → [tool:{','.join(tc_names)}]"

            if role == 'tool':
                tool_call_id = msg.get('tool_call_id', '')
                tool_name = msg.get('name', 'unknown')
                lines.append(f"{global_num}. MSG-{global_num:03d} [tool:{tool_name}:{tool_call_id}]")
            else:
                lines.append(f"{global_num}. MSG-{global_num:03d} [{role}]: {preview}{tool_ref}")

        lines.append("")

        # Archived files access instructions
        # Find the first tool message number for a useful example
        first_tool_num = None
        for i, msg in enumerate(messages, 1):
            if msg.get('role') == 'tool':
                first_tool_num = total_before + i
                break
        example_file = f"MSG-{first_tool_num:03d}_tool.md" if first_tool_num else f"MSG-{msg_start:03d}_user.md"

        lines.append("## Archived Files (you have full access)")
        lines.append("Earlier messages were compressed into this summary. The full data "
                      "(URLs, sources, tool outputs, exact content) is saved in your sandbox "
                      f"at /workspace/{self.BASE_DIR}/.")
        lines.append("These files are in YOUR sandbox — you already have full access. "
                      "If the user asks for details not in this summary, just read the files. "
                      "Do not ask the user for permission or say you lack access.")
        lines.append("```bash")
        lines.append(f"cat /workspace/{self.BASE_DIR}/messages/batch_{batch_number:03d}/{example_file}  # tool outputs with URLs/data")
        lines.append(f"ls /workspace/{self.BASE_DIR}/messages/batch_{batch_number:03d}/  # list all archived files")
        lines.append(f"grep -ri \"keyword\" /workspace/{self.BASE_DIR}/  # search across all batches")
        lines.append("```")

        return "\n".join(lines)

    async def _generate_summary(
        self,
        messages: List[Dict[str, Any]],
        batch_number: int,
        model: str,
        previous_summary: str = None
    ) -> Dict[str, Any]:
        """Generate summary via LLM."""
        from core.agentpress.thread_manager.services.execution.llm_executor import make_llm_api_call

        formatted_messages = self._format_messages_for_prompt(messages)

        previous_context = ""
        if previous_summary:
            previous_context = f"""PREVIOUS CONTEXT (cumulative summary of all earlier batches - INCORPORATE this into your new summary):
{previous_summary}

---

"""

        prompt = f"""Summarize this conversation for an AI agent. Be CONCISE.

{previous_context}NEW MESSAGES ({len(messages)} total):
{formatted_messages}

{"Merge the previous context with the new messages into ONE cohesive cumulative summary. Do not lose important details from the previous context." if previous_summary else ""}

Return JSON:
{{
  "summary": "2-3 paragraph cumulative summary covering ALL context (previous + new)",
  "topics": ["topic1", "topic2"],
  "key_decisions": [{{"decision": "...", "rationale": "..."}}],
  "facts": {{
    "project_name": "if mentioned",
    "tech_stack": ["tech1", "tech2"],
    "current_goal": "what user wants"
  }}
}}

Return ONLY valid JSON."""

        try:
            response = await asyncio.wait_for(
                make_llm_api_call(
                    messages=[{"role": "user", "content": prompt}],
                    model_name=model,
                    temperature=0.1,
                    max_tokens=1500,
                    stream=False
                ),
                timeout=30
            )

            # Non-streaming: extract content from ModelResponse
            if hasattr(response, 'choices') and response.choices:
                full_response = response.choices[0].message.content or ""
            elif isinstance(response, dict):
                full_response = response.get("content", str(response))
            elif isinstance(response, str):
                full_response = response
            else:
                full_response = str(response)

            return json.loads(full_response)

        except asyncio.TimeoutError:
            logger.warning(f"[ContextArchiver] Summary LLM call timed out after 30s, using fallback")
            return self._fallback_summary(messages)
        except json.JSONDecodeError as e:
            logger.error(f"[ContextArchiver] Failed to parse LLM response: {e}")
            return self._fallback_summary(messages)
        except Exception as e:
            logger.error(f"[ContextArchiver] Summary generation failed: {e}")
            return self._fallback_summary(messages)

    def _fallback_summary(self, messages: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Generate fallback summary without LLM."""
        return {
            "summary": f"Archived {len(messages)} messages.",
            "topics": [],
            "key_decisions": [],
            "facts": {}
        }

    def _format_messages_for_prompt(self, messages: List[Dict[str, Any]]) -> str:
        """Format messages for the summarization prompt."""
        lines = []
        for i, msg in enumerate(messages, 1):
            role = msg.get('role', 'unknown').upper()
            content = msg.get('content', '')

            if isinstance(content, list):
                text_parts = []
                for block in content:
                    if isinstance(block, dict):
                        if block.get('type') == 'text':
                            text_parts.append(block.get('text', ''))
                        elif block.get('type') == 'tool_use':
                            text_parts.append(f"[tool:{block.get('name')}]")
                        elif block.get('type') == 'tool_result':
                            text_parts.append(f"[result:{str(block.get('content', ''))[:100]}]")
                content = ' '.join(text_parts)
            elif isinstance(content, dict):
                content = json.dumps(content)

            content_str = str(content)
            if len(content_str) > 300:
                content_str = content_str[:300] + "..."

            lines.append(f"MSG-{i:03d} [{role}]: {content_str}")

        return "\n".join(lines)

    def _build_retrieval_hints(
        self,
        summary: Dict[str, Any],
        batch_number: int,
        message_count: int
    ) -> List[RetrievalHint]:
        """Build retrieval hints from summary data."""
        hints = []
        for topic in summary.get("topics", []):
            hints.append(RetrievalHint(
                topic=topic,
                keywords=[topic],
                message_range=f"batch_{batch_number:03d}"
            ))
        return hints


def format_archive_summary(result: ArchiveResult) -> str:
    """Return the full disk summary content for the agent's context."""
    return result.full_summary_content
