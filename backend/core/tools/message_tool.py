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
## Message Tools - User communication interface

Your PRIMARY interface for all user communication. Every response MUST use either `ask` or `complete`.

### Available Tools
- **ask**: Communicate with users, share information, ask questions
- **complete**: Signal that ALL work is finished
- **wait**: Pause execution for a specified duration

### When to Use `ask`
- Answering questions or providing explanations
- Sharing research results or information
- Asking for clarification when genuinely needed
- Presenting intermediate results during complex work
- Any response that expects or allows further user input

### When to Use `complete`
ONLY when ALL of these are true:
1. ALL tasks are 100% finished (no pending work)
2. All deliverables have been created and attached
3. No further user input is needed

### Critical Rules

**Duplicate Content Prevention:**
- NEVER output raw text AND use ask/complete with the same content
- Put ALL content INSIDE the tool's `text` parameter ONLY
- Raw text before/after tool calls causes annoying duplication for users

**Correct Usage:**
```
[calls ask with "Here's what I found..."]
```

**Incorrect Usage:**
```
Here's what I found...
[calls ask with "Here's what I found..."]
```

**Attachment Protocol:**
- ALL results, deliverables, outputs MUST be attached via `attachments` parameter
- NEVER describe results without attaching the actual files
- HTML files, PDFs, images, charts, spreadsheets → ALWAYS attach

**Follow-up Answers:**
- Every `ask` call MUST include `follow_up_answers` with 2-4 actionable options
- For clarifications: specific clickable options
- For information: suggest what user can do NEXT with the information

### Communication Style
- Focus on OUTCOMES, not implementation details
- Use natural, conversational language
- Hide technical complexity (no tool names, libraries, APIs)
- Be direct - avoid filler phrases ("Certainly!", "Of course!")
- Keep responses concise and actionable

### Handling User Uploads
Files in `uploads/` directory:
- **Images** (jpg, png, gif, webp, svg): Use `load_image`
- **All other files** (PDF, Word, Excel, CSV): Use `search_file` FIRST
- Only use `read_file` for tiny config files (<2KB)
"""
)
class MessageTool(Tool):
    def __init__(self):
        super().__init__()

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "ask",
            "description": "Communicate with the user. Use for: questions, sharing information, presenting results, requesting input. This is your PRIMARY communication tool. ALWAYS include follow_up_answers with actionable suggestions. ALWAYS attach files when sharing results. CRITICAL: Put ALL content in the text parameter - never duplicate as raw text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "**REQUIRED** - Your message to the user. Be conversational and focus on outcomes, not technical details."
                    },
                    "attachments": {
                        "anyOf": [
                            {"type": "string"},
                            {"items": {"type": "string"}, "type": "array"}
                        ],
                        "description": "**REQUIRED when sharing results** - Files or URLs to attach. MANDATORY for any deliverables, outputs, or work products. Use relative paths to /workspace."
                    },
                    "follow_up_answers": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "**MANDATORY** - 2-4 actionable suggestions the user can click. For questions: specific options. For information: suggest what they can do next (create presentation, build webpage, etc.)."
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
            "description": "Signal that ALL work is complete. Use ONLY when: 1) All tasks are done, 2) All deliverables created, 3) No further input needed. MANDATORY: Attach ALL outputs and include follow_up_prompts for next steps.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "**OPTIONAL** - Summary of what was accomplished."
                    },
                    "attachments": {
                        "anyOf": [
                            {"type": "string"},
                            {"items": {"type": "string"}, "type": "array"}
                        ],
                        "description": "**REQUIRED when deliverables exist** - ALL files, outputs, and work products created. For presentations: attach first slide only (e.g., presentations/[name]/slide_01.html)."
                    },
                    "follow_up_prompts": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "**MANDATORY** - 3-4 actionable suggestions for what the user can do next with the completed work."
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
            "description": "Pause execution for a specified duration. Use for deliberate pacing in long-running processes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "seconds": {
                        "type": "integer",
                        "description": "**REQUIRED** - Seconds to wait (1-300).",
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

    asyncio.run(test_message_tool())
