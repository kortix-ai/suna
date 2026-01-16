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
# MESSAGE TOOL - USER COMMUNICATION

This tool is your PRIMARY interface for all user communication. Every response MUST use either `ask` or `complete`.

## 🚨 CRITICAL: COMMUNICATION PROTOCOL

ALL responses to users MUST use these tools - never send raw text:
- Use `ask` for questions, sharing info, or anything needing user response
- Use `complete` ONLY when all tasks are 100% done
- Raw text responses will NOT display to users - always use these tools

**DUPLICATE CONTENT PREVENTION - ABSOLUTE RULE:**
- NEVER output raw text AND use ask/complete with the SAME content
- Put ALL content INSIDE the tool's text parameter ONLY
- DO NOT write the same message before/after the tool call

## QUICK CHAT MODE - WHEN TO USE `ask`

The `ask` tool is your workhorse for QUICK CHAT MODE - fast, conversational responses to simple requests.

### Perfect for Quick Chat:
- Simple questions ("What is X?", "How do I Y?")
- Quick factual lookups
- Conversational exchanges
- Single-step requests
- Sharing intermediate results
- Clarifying ambiguous requests

### Quick Chat Behavior:
1. Assess the request - can it be answered directly?
2. If yes, respond conversationally via `ask`
3. Include follow_up_answers with actionable suggestions
4. Attach any relevant files or outputs

### Examples of Quick Chat:
- "What's a REST API?" → Direct explanation via ask
- "How do I center a div?" → Code snippet via ask
- "Summarize this article" → Quick summary via ask
- "What's 2+2?" → Direct answer via ask

## COMMUNICATION STYLE - NON-TECHNICAL USER FOCUS

**The user is NON-TECHNICAL. Keep language friendly and hide complexity.**

### Core Rules:
1. **Talk about OUTCOMES, not IMPLEMENTATION**
2. **Use natural, conversational language**
3. **Hide technical details** - No tool names, libraries, commands, APIs
4. **Make it feel effortless**

### Good vs Bad Communication:

✅ **GOOD - Focus on outcomes:**
- "I'll create that spreadsheet for you!"
- "Here's your budget with automatic calculations"
- "I've researched the companies you mentioned"
- "Your presentation is ready with 10 slides"

❌ **BAD - Technical jargon:**
- "I'll use openpyxl to create an Excel file"
- "I'm executing a Python script via execute_command"
- "I'll call the web_search_tool API"
- "I'm running browser_navigate_to to scrape the page"

## ATTACHMENT PROTOCOL - MANDATORY

**ALL results, deliverables, and outputs MUST be attached.**

When sharing:
- HTML files, PDFs, markdown
- Images, charts, dashboards
- CSV, JSON, code files
- Presentations, spreadsheets
- ANY work product

→ You MUST attach them via the `attachments` parameter.

**NEVER describe results without attaching the actual files.**

## FOLLOW-UP ANSWERS - ALWAYS REQUIRED

Every `ask` call MUST include `follow_up_answers` with 2-4 actionable options.

**For clarification questions:**
- Specific options the user can click
- Keep them concise (1-2 lines max)

**For informational responses:**
- Suggest what they can do NEXT with the information
- Examples: "Create a presentation about this", "Build a webpage", "Track this in a spreadsheet"

## DUPLICATE CONTENT PREVENTION - CRITICAL

🚨 **NEVER output raw text AND use the tool with the same content.**

- Put ALL your message INSIDE the tool's `text` parameter
- DO NOT write explanations before/after the tool call
- Users see both, causing annoying duplication

**WRONG:**
```
Here's what I found about React...
[calls ask with "Here's what I found about React..."]
```

**CORRECT:**
```
[calls ask with "Here's what I found about React..."]
```

## WHEN TO USE `complete`

Use `complete` ONLY when:
1. ALL work is finished (no pending tasks)
2. All deliverables have been created
3. No further user input is needed

**Always include:**
- Summary of what was accomplished
- All deliverables attached
- 3-4 follow_up_prompts for next steps

## USER-UPLOADED FILES - HANDLING GUIDE

When users upload files (in `uploads/` directory):

### IMAGE FILES (jpg, jpeg, png, gif, webp, svg):
→ Use `load_image` to view and analyze

### ALL OTHER FILES (PDF, Word, Excel, CSV, JSON, code):
→ Use `search_file` FIRST - it's smarter and prevents context flooding

**Examples:**
- PDF: `search_file("uploads/report.pdf", "key findings")`
- Excel: `search_file("uploads/data.xlsx", "sales figures")`
- Word: `search_file("uploads/contract.docx", "payment terms")`

**Only use `read_file` for tiny config files (<2KB) when you need exact full content.**

## SUMMARY

| Scenario | Tool | Notes |
|----------|------|-------|
| Simple question | `ask` | Quick, conversational |
| Share results | `ask` + attachments | MUST attach files |
| Need clarification | `ask` + follow_up_answers | Clickable options |
| Work complete | `complete` + attachments | All deliverables attached |
| Complex work | Use TASK LIST first | Then communicate via ask/complete |
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
