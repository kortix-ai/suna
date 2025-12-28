from typing import List, Optional, Union
from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.utils.logger import logger

@tool_metadata(
    display_name="Chat & Messages",
    description="Talk with users, ask questions, and share updates about your work",
    icon="MessageSquare",
    color="bg-purple-100 dark:bg-purple-800/50",
    is_core=True,
    weight=310,
    visible=True,
    usage_guide="""
### CRITICAL: MANDATORY TOOL USAGE FOR ALL USER COMMUNICATION

**ALL communication with users MUST use 'ask' or 'complete' tools. Raw text responses will NOT be displayed properly.**

**WHEN TO USE 'ask' TOOL:**
- **MANDATORY** for asking clarifying questions
- **MANDATORY** for requesting user input or confirmation
- **MANDATORY** for sharing information that requires user response
- **MANDATORY** for presenting options or choices
- **MANDATORY** for waiting for user feedback or decisions
- **MANDATORY** for conversational interaction
- **MANDATORY** for sharing files, visualizations, or deliverables (attach them)
- **🚨 CRITICAL:** When sharing any results, outputs, or deliverables, you MUST attach them - never just describe them

**WHEN TO USE 'complete' TOOL:**
- **MANDATORY** when ALL tasks are finished and no user response needed
- **MANDATORY** when signaling final completion of work
- **MANDATORY** when providing final results without requiring user input
- **🚨 CRITICAL:** You MUST attach ALL deliverables, outputs, files, and results before calling complete - this is NOT optional

**FORBIDDEN:**
- ❌ NEVER send raw text responses without tool calls - information will be LOST
- ❌ NEVER send questions as plain text - ALWAYS use 'ask' tool
- ❌ NEVER signal completion without 'complete' tool

**ATTACHMENT PROTOCOL:**
- **🚨 MANDATORY: ALL RESULTS MUST BE ATTACHED** when using 'ask' or 'complete' tools
- **CRITICAL: ALL VISUALIZATIONS MUST BE ATTACHED** when using 'ask' tool
- **CRITICAL: ALL DELIVERABLES MUST BE ATTACHED** when using 'complete' tool
- This includes: HTML files, PDFs, markdown, images, charts, reports, dashboards, CSV files, JSON files, presentations, spreadsheets, code files, or ANY work product
- If you created it, generated it, or produced it during the task, you MUST attach it
- If user should SEE it, you must ATTACH it
- Verify ALL outputs and deliverables are attached before calling ask or complete
- **NEVER complete a task without attaching the results** - this breaks the user experience

**CONSEQUENCES:**
- Raw text responses are NOT displayed properly to users
- Valuable information will be LOST if not sent via tools
- User experience will be BROKEN without proper tool usage
"""
)
class MessageTool(Tool):
    def __init__(self):
        super().__init__()

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "ask",
            "description": "Ask user a question and wait for response. Use for: 1) Requesting clarification on ambiguous requirements (ONLY when truly blocked), 2) Seeking confirmation before proceeding with high-impact changes, 3) Gathering additional information needed to complete a task, 4) Offering options and requesting user preference, 5) Validating assumptions when critical to task success, 6) When encountering unclear or ambiguous results during task execution, 7) When tool results don't match expectations, 8) For natural conversation and follow-up questions, 9) When research reveals multiple entities with the same name, 10) When user requirements are unclear or could be interpreted differently. IMPORTANT: Use this tool when user input is essential to proceed. 🚨 CRITICAL: For clarification questions, ALWAYS provide follow_up_answers with 2-4 clickable options - users should click, not type. Keep questions CONCISE (1-2 sentences max) and scannable. Use natural, conversational language. 🚨 MANDATORY: When sharing results, deliverables, files, visualizations, or any work product, you MUST attach them via the attachments parameter - never share information about results without attaching the actual files. Include relevant attachments when the question relates to specific files or resources. CRITICAL: When you discover ambiguity (like multiple people with the same name), immediately stop and ask for clarification with clickable options rather than making assumptions. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `text` (REQUIRED), `attachments` (REQUIRED when sharing results/deliverables), `follow_up_answers` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "**REQUIRED** - Question text to present to user. Should be specific and clearly indicate what information you need. Use natural, conversational language. Include: 1) Clear question or request, 2) Context about why the input is needed, 3) Available options if applicable, 4) Impact of different choices, 5) Any relevant constraints or considerations."
                    },
                    "attachments": {
                        "anyOf": [
                            {"type": "string"},
                            {"items": {"type": "string"}, "type": "array"}
                        ],
                        "description": "**REQUIRED when sharing results/deliverables** - List of files or URLs to attach. 🚨 MANDATORY: If you created, generated, or produced any files, reports, dashboards, visualizations, or work products, you MUST attach them here. Include when: 1) Sharing results, deliverables, or outputs (MANDATORY), 2) Question relates to specific files or configurations, 3) User needs to review content before answering, 4) Options or choices are documented in files, 5) Supporting evidence or context is needed. Always use relative paths to /workspace directory. NEVER share information about results without attaching the actual files."
                    },
                    "follow_up_answers": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "**OPTIONAL** - 🚨 MANDATORY for clarification questions - users should click answers, not type them. Array of suggested follow-up answer strings (2-4 options). MUST be an array of strings, not a JSON string. Keep answers CONCISE (1-2 lines max) and SPECIFIC. Example: ['Yes, create React component with TypeScript', 'Skip tests for now and deploy', 'Use existing API endpoint instead']. Maximum 4 suggestions."
                    }
                },
                "required": ["text"],
                "additionalProperties": False
            }
        }
    })
    async def ask(self, text: str, attachments: Optional[Union[str, List[str]]] = None, follow_up_answers: Optional[List[str]] = None) -> ToolResult:
        try:            
            if attachments and isinstance(attachments, str):
                attachments = [attachments]
          
            return self.success_response({"status": "Awaiting user response..."})
        except Exception as e:
            return self.fail_response(f"Error asking user: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "complete",
            "description": "A special tool to indicate you have completed all tasks and are about to enter complete state. Use ONLY when: 1) All tasks in todo.md are marked complete [x], 2) The user's original request has been fully addressed, 3) There are no pending actions or follow-ups required, 4) You've delivered all final outputs and results to the user. IMPORTANT: This is the ONLY way to properly terminate execution. Never use this tool unless ALL tasks are complete and verified. 🚨 MANDATORY: You MUST attach ALL deliverables, outputs, files, visualizations, reports, dashboards, or any work product you created via the attachments parameter - this is NOT optional. If you created files during the task, they MUST be attached. Always ensure you've provided all necessary outputs and references before using this tool. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `text` (optional), `attachments` (REQUIRED when results/deliverables exist), `follow_up_prompts` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "**OPTIONAL** - Completion message or summary to present to user. Should provide clear indication of what was accomplished. Include: 1) Summary of completed tasks, 2) Key deliverables or outputs, 3) Any important notes or next steps, 4) Impact or benefits achieved."
                    },
                    "attachments": {
                        "anyOf": [
                            {"type": "string"},
                            {"items": {"type": "string"}, "type": "array"}
                        ],
                        "description": "**REQUIRED when results/deliverables exist** - List of files or URLs to attach to the completion message. 🚨 MANDATORY: If you created, generated, or produced ANY files, reports, dashboards, visualizations, spreadsheets, presentations, code files, or work products during the task, you MUST attach them here. This includes: 1) All deliverables and outputs (MANDATORY), 2) Completion relates to specific files or configurations, 3) User needs to review final outputs, 4) Deliverables are documented in files, 5) Supporting evidence or context is needed. Always use relative paths to /workspace directory. **For presentations**: When attaching presentation files, only attach the first slide (e.g., `presentations/[name]/slide_01.html`) to keep the UI tidy - the presentation card will automatically show the full presentation. **VERIFICATION**: Before calling complete, verify you've attached all created files and outputs."
                    },
                    "follow_up_prompts": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "**OPTIONAL** - List of suggested follow-up prompts the user can click to continue working. Make prompts SPECIFIC to what was just completed - reference actual file names, components, features, or deliverables created. Maximum 4 suggestions, each should clearly describe a specific actionable task."
                    }
                },
                "required": [],
                "additionalProperties": False
            }
        }
    })
    async def complete(self, text: Optional[str] = None, attachments: Optional[Union[str, List[str]]] = None, follow_up_prompts: Optional[List[str]] = None) -> ToolResult:
        try:
            if attachments and isinstance(attachments, str):
                attachments = [attachments]
                
            return self.success_response({"status": "complete"})
        except Exception as e:
            return self.fail_response(f"Error entering complete state: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "wait",
            "description": "Pause execution for a specified number of seconds. Use this tool to add deliberate pauses in long-running processes to prevent rushing and maintain a steady, thoughtful pace. This helps prevent errors and ensures quality execution. **🚨 PARAMETER NAMES**: Use EXACTLY this parameter name: `seconds` (REQUIRED).",
            "parameters": {
                "type": "object",
                "properties": {
                    "seconds": {
                        "type": "integer",
                        "description": "**REQUIRED** - Number of seconds to wait (1-300 seconds). Use 1-3 seconds for brief pauses, 5-10 seconds for processing waits, 60+ seconds for longer operations.",
                        "minimum": 1,
                        "maximum": 300
                    }
                },
                "required": ["seconds"],
                "additionalProperties": False
            }
        }
    })
    async def wait(self, seconds: int) -> ToolResult:
        try:
            if seconds < 1 or seconds > 300:
                return self.fail_response("Duration must be between 1 and 300 seconds")
            
            import asyncio
            
            logger.info(f"Agent waiting {seconds} seconds")
            
            await asyncio.sleep(seconds)
            
            return self.success_response(f"Waited {seconds} seconds")
            
        except Exception as e:
            return self.fail_response(f"Error during wait: {str(e)}")


if __name__ == "__main__":
    import asyncio

    async def test_message_tool():
        message_tool = MessageTool()

        ask_result = await message_tool.ask(
            text="Would you like to proceed with the next phase?",
            attachments="summary.pdf"
        )
        print("Question result:", ask_result)

        inform_result = await message_tool.inform(
            text="Completed analysis of data. Processing results now.",
            attachments="analysis.pdf"
        )
        print("Inform result:", inform_result)

    asyncio.run(test_message_tool())
