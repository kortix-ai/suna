import asyncio
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, Any, List

from core.utils.logger import logger

# Max chars to keep in individual MSG files for tool outputs
_TOOL_OUTPUT_MAX_CHARS = 20_000
# Regex to extract URLs
_URL_RE = re.compile(r'https?://[^\s"\'>}\]\\]+', re.IGNORECASE)


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
        previous_summary: str = None,
        working_memory: List[Dict[str, Any]] = None
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
        # Include working memory in the summary so it covers the full conversation state
        all_messages = messages + (working_memory or [])
        file_write_task = self._write_message_files(sandbox, all_messages, batch_number, total_before)
        summary_task = self._generate_summary(all_messages, batch_number, model, previous_summary)
        tool_results_written, summary_data = await asyncio.gather(file_write_task, summary_task)

        # Write summary file + update manifest in parallel
        summary_path = f"{self.WORKSPACE_PATH}/{self.BASE_DIR}/summaries/batch_{batch_number:03d}.md"
        summary_content = self._format_summary_file(batch_number, all_messages, summary_data, tool_results_written, total_before, archived_count=len(messages))

        retrieval_hints = self._build_retrieval_hints(summary_data, batch_number, len(messages))
        tokens_archived = sum(len(str(m.get('content', ''))) // 4 for m in messages)

        await asyncio.gather(
            sandbox.fs.upload_file(summary_content.encode('utf-8'), summary_path),
            self._update_manifest(
                sandbox=sandbox,
                manifest=manifest,
                batch_number=batch_number,
                message_count=len(all_messages),
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

    @staticmethod
    def _extract_urls_from_content(content) -> List[str]:
        """Extract unique URLs from message content."""
        text = json.dumps(content) if not isinstance(content, str) else content
        urls = _URL_RE.findall(text)
        # Deduplicate while preserving order, strip trailing punctuation
        seen = set()
        clean = []
        for url in urls:
            url = url.rstrip('.,;:)]}')
            if url not in seen:
                seen.add(url)
                clean.append(url)
        return clean

    async def _write_message_files(
        self,
        sandbox,
        messages: List[Dict[str, Any]],
        batch_number: int,
        total_before: int = 0
    ) -> Dict[str, str]:
        """Write individual message files, links.md, and index. Returns tool_call_id -> filename mapping."""
        batch_dir = f"{self.WORKSPACE_PATH}/{self.BASE_DIR}/messages/batch_{batch_number:03d}"
        try:
            await sandbox.fs.create_folder(batch_dir, "755")
        except Exception:
            pass

        tool_results_written = {}
        upload_tasks = []
        # Collect URLs per tool for links.md
        all_links: List[dict] = []  # [{tool_name, msg_num, urls}]

        for i, msg in enumerate(messages, 1):
            global_num = total_before + i
            role = msg.get('role', 'unknown')
            filename = f"MSG-{global_num:03d}_{role}.md"
            filepath = f"{batch_dir}/{filename}"

            msg_content = self._format_message_file(global_num, msg)

            # Truncate large tool outputs so MSG files stay readable
            if role == 'tool' and len(msg_content) > _TOOL_OUTPUT_MAX_CHARS:
                truncated_at = _TOOL_OUTPUT_MAX_CHARS
                msg_content = (
                    msg_content[:truncated_at]
                    + f"\n\n... [TRUNCATED — original was {len(msg_content):,} chars. "
                    + "Full URLs extracted to links.md in this batch directory.]\n"
                )

            upload_tasks.append(sandbox.fs.upload_file(msg_content.encode('utf-8'), filepath))

            # Extract URLs from tool outputs
            if role == 'tool':
                tool_call_id = msg.get('tool_call_id', '')
                if tool_call_id:
                    tool_results_written[tool_call_id] = filename
                content = msg.get('content', '')
                urls = self._extract_urls_from_content(content)
                if urls:
                    tool_name = msg.get('name', 'unknown')
                    all_links.append({
                        "tool_name": tool_name,
                        "msg_num": global_num,
                        "filename": filename,
                        "urls": urls
                    })

            if role == 'assistant':
                tool_calls = msg.get('tool_calls', [])
                for tc in tool_calls:
                    tc_id = tc.get('id', '')
                    if tc_id:
                        tool_results_written[tc_id] = f"MSG-{global_num:03d}_assistant.md"

        # Write links.md — compact file with all URLs extracted from tool outputs
        if all_links:
            links_lines = [
                "# Extracted Links & Sources",
                f"Batch {batch_number:03d} | Messages {total_before+1}-{total_before+len(messages)}",
                ""
            ]
            for entry in all_links:
                links_lines.append(f"## MSG-{entry['msg_num']:03d} ({entry['tool_name']})")
                for url in entry["urls"]:
                    links_lines.append(f"- {url}")
                links_lines.append("")

            upload_tasks.append(sandbox.fs.upload_file(
                "\n".join(links_lines).encode('utf-8'),
                f"{batch_dir}/links.md"
            ))

        # Write index.md listing all files by role
        index_lines = ["# File Index", f"Batch {batch_number:03d}", ""]
        tool_files = []
        user_files = []
        for i, msg in enumerate(messages, 1):
            global_num = total_before + i
            role = msg.get('role', 'unknown')
            fname = f"MSG-{global_num:03d}_{role}.md"
            if role == 'tool':
                tool_name = msg.get('name', '')
                tool_files.append(f"- {fname}  ({tool_name})" if tool_name else f"- {fname}")
            elif role == 'user':
                preview = str(msg.get('content', ''))[:80].replace('\n', ' ')
                user_files.append(f"- {fname}  ({preview})")

        if tool_files:
            index_lines.append("## Tool outputs (search results, data, URLs)")
            index_lines.extend(tool_files)
            index_lines.append("")
        if user_files:
            index_lines.append("## User messages")
            index_lines.extend(user_files)
            index_lines.append("")
        index_lines.append("## Quick access")
        index_lines.append("- links.md  (all URLs extracted from tool outputs)")
        index_lines.append("")

        upload_tasks.append(sandbox.fs.upload_file(
            "\n".join(index_lines).encode('utf-8'),
            f"{batch_dir}/index.md"
        ))

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
        total_before: int = 0,
        archived_count: int = None
    ) -> str:
        """Format the summary file with conversation flow and references."""
        if archived_count is None:
            archived_count = len(messages)
        timestamp = datetime.now(timezone.utc).isoformat()
        topics = ", ".join(summary_data.get("topics", ["general"]))
        msg_start = total_before + 1
        msg_end = total_before + archived_count

        lines = [
            "[ARCHIVED CONTEXT]",
            "",
            f"# Batch {batch_number:03d} Summary",
            f"Messages: {msg_start}-{msg_end} | Archived: {timestamp}",
            f"Topics: {topics}",
            "",
            "## Summary",
            summary_data.get("summary", "No summary available."),
            ""
        ]

        batch_dir = f"/workspace/{self.BASE_DIR}/messages/batch_{batch_number:03d}"

        lines.append("## MANDATORY: How to retrieve specific data")
        lines.append("The full data (URLs, sources, tool outputs, exact content) is saved "
                      f"at {batch_dir}/.")
        lines.append("When the user asks for details, numbers, links, or sources from earlier work: "
                      "DO NOT respond to the user first. DO NOT say \"I don't have access\". "
                      "DO NOT ask if they want you to retrieve the data. "
                      "Your FIRST tool call must be read_file or grep — THEN respond with the results.")
        lines.append(f"**For links/URLs:** read_file {batch_dir}/links.md (compact file with all URLs)")
        lines.append(f"**For specific data:** grep -ri \"keyword\" {batch_dir}/")
        lines.append(f"**To see all files:** read_file {batch_dir}/index.md")
        lines.append("Do NOT use cat. Do NOT guess filenames. Read index.md or links.md first.")
        lines.append("")

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
            is_working_memory = i > archived_count

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

            wm_tag = " (working memory)" if is_working_memory else ""

            # Add tool call references
            tool_ref = ""
            tool_calls = msg.get('tool_calls', [])
            if tool_calls:
                tc_names = [tc.get('function', {}).get('name', '?') for tc in tool_calls]
                tool_ref = f" → [tool:{','.join(tc_names)}]"

            if role == 'tool':
                tool_call_id = msg.get('tool_call_id', '')
                tool_name = msg.get('name', 'unknown')
                lines.append(f"{global_num}. MSG-{global_num:03d} [tool:{tool_name}:{tool_call_id}]{wm_tag}")
            else:
                lines.append(f"{global_num}. MSG-{global_num:03d} [{role}]: {preview}{tool_ref}{wm_tag}")

        lines.append("")

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
