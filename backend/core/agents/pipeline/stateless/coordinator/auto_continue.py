import json
from typing import Dict, Any

from core.utils.logger import logger


class AutoContinueChecker:
    @staticmethod
    def check(chunk: Dict[str, Any], count: int, max_continues: int) -> tuple[bool, bool]:
        if count >= max_continues:
            return False, False

        if chunk.get("type") != "status":
            return False, False

        content = AutoContinueChecker._parse_json_field(chunk.get("content", {}))
        metadata = AutoContinueChecker._parse_json_field(chunk.get("metadata", {}))

        if metadata.get("agent_should_terminate"):
            logger.debug("[AutoContinue] Disabled: agent_should_terminate flag set")
            return False, True

        status_type = content.get("status_type") if isinstance(content, dict) else None
        if status_type == "terminating_tool_completed":
            logger.debug("[AutoContinue] Terminating tool completed, stopping")
            return False, True

        finish_reason = content.get("finish_reason") if isinstance(content, dict) else None

        if finish_reason in ("tool_calls", "length"):
            return True, False

        if finish_reason in ("stop", "end_turn", "agent_terminated"):
            return False, False

        return False, False

    @staticmethod
    def _parse_json_field(field):
        if isinstance(field, str):
            try:
                return json.loads(field)
            except:
                return {}
        return field
