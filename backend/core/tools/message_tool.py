from typing import List, Optional, Union
from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.utils.logger import logger

@tool_metadata(
    display_name="AskUser",
    description="Ask questions and communicate with users during execution",
    icon="MessageSquare",
    color="bg-purple-100 dark:bg-purple-800/50",
    is_core=True,
    weight=310,
    visible=True,
    usage_guide="""
## AskUser - User communication and question interface

Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

### Available Tools
- **ask**: Ask questions, share information, request user input
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

### Usage Notes
- Users will always be able to select "Other" to provide custom text input
- Use follow_up_answers to provide 2-4 actionable options users can click
- If you recommend a specific option, make that the first option in the list

### Critical Rules

**Duplicate Content Prevention:**
- NEVER output raw text AND use ask/complete with the same content
- Put ALL content INSIDE the tool's `text` parameter ONLY
- Raw text before/after tool calls causes duplication for users

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
- Every `ask` call SHOULD include `follow_up_answers` with 2-4 actionable options
- For clarifications: specific clickable options
- For information: suggest what user can do NEXT with the information

### Communication Style
- Focus on OUTCOMES, not implementation details
- Use natural, conversational language
- Hide technical complexity (no tool names, libraries, APIs)
- Be direct - avoid filler phrases ("Certainly!", "Of course!")
- Keep responses concise and actionable
- Only use emojis if the user explicitly requests it
"""
)
class MessageTool(Tool):
    def __init__(self):
        super().__init__()

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "ask",
            "description": """Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use follow_up_answers to allow multiple answer options to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end

CRITICAL: Put ALL content in the text parameter - never duplicate as raw text outside the tool call.""",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "**REQUIRED** - Your message to the user. Be clear, specific, and conversational. Focus on outcomes, not technical details."
                    },
                    "attachments": {
                        "anyOf": [
                            {"type": "string"},
                            {"items": {"type": "string"}, "type": "array"}
                        ],
                        "description": "**OPTIONAL** - Files or URLs to attach. Use for any deliverables, outputs, or work products. Use relative paths to /workspace."
                    },
                    "follow_up_answers": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "**OPTIONAL** - 2-4 actionable suggestions the user can click. For questions: specific options. For information: suggest what they can do next."
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
