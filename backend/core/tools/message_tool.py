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

**WHEN TO USE 'complete' TOOL:**
- **MANDATORY** when ALL tasks are finished and no user response needed
- **MANDATORY** when signaling final completion of work
- **MANDATORY** when providing final results without requiring user input

**FORBIDDEN:**
- ❌ NEVER send raw text responses without tool calls - information will be LOST
- ❌ NEVER send questions as plain text - ALWAYS use 'ask' tool
- ❌ NEVER signal completion without 'complete' tool

**ATTACHMENT PROTOCOL:**
- **CRITICAL: ALL VISUALIZATIONS MUST BE ATTACHED** when using 'ask' tool
- This includes: HTML files, PDFs, markdown, images, charts, reports, dashboards
- If user should SEE it, you must ATTACH it
- Verify ALL visual outputs attached before proceeding

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
            "description": "Ask user a question and wait for response. Use for: 1) Requesting clarification on ambiguous requirements, 2) Seeking confirmation before proceeding with high-impact changes, 3) Gathering additional information needed to complete a task, 4) Offering options and requesting user preference, 5) Validating assumptions when critical to task success, 6) When encountering unclear or ambiguous results during task execution, 7) When tool results don't match expectations, 8) For natural conversation and follow-up questions, 9) When research reveals multiple entities with the same name, 10) When user requirements are unclear or could be interpreted differently. IMPORTANT: Use this tool when user input is essential to proceed. Always provide clear context and options when applicable. Use natural, conversational language that feels like talking with a helpful friend. Include relevant attachments when the question relates to specific files or resources. CRITICAL: When you discover ambiguity (like multiple people with the same name), immediately stop and ask for clarification rather than making assumptions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Question text to present to user - should be specific and clearly indicate what information you need. Use natural, conversational language. Include: 1) Clear question or request, 2) Context about why the input is needed, 3) Available options if applicable, 4) Impact of different choices, 5) Any relevant constraints or considerations."
                    },
                    "attachments": {
                        "anyOf": [
                            {"type": "string"},
                            {"items": {"type": "string"}, "type": "array"}
                        ],
                        "description": "(Optional) List of files or URLs to attach to the question. Include when: 1) Question relates to specific files or configurations, 2) User needs to review content before answering, 3) Options or choices are documented in files, 4) Supporting evidence or context is needed. Always use relative paths to /workspace directory."
                    },
                    "follow_up_answers": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "(Optional) Array of suggested follow-up answer strings. MUST be valid JSON array format: [\"answer1\", \"answer2\"]. CRITICAL GUIDELINES: 1) Make answers SPECIFIC to the question being asked - reference the actual options, files, or choices presented, 2) Include the actual option/choice in the answer (e.g., 'Use Python with FastAPI for the backend' not just 'Option A'), 3) Add brief reasoning when helpful (e.g., 'Yes, deploy to production - the tests are passing' not just 'Yes'), 4) For yes/no questions, include context (e.g., 'Yes, proceed with the dark theme' not just 'Yes'), 5) For multiple choice, reference the specific choice (e.g., 'Go with the PostgreSQL approach for better scalability'), 6) Avoid generic responses like 'Yes', 'No', 'Option A' - make them descriptive and contextual. GOOD EXAMPLES: 'Yes, create the React component with TypeScript', 'Skip the tests for now and deploy', 'Use the existing API endpoint instead', 'Let me provide more details about the requirements'. BAD EXAMPLES: 'Yes', 'No', 'Option 1', 'Proceed'. Maximum 4 suggestions, each should be self-explanatory when read standalone."
                    }
                },
                "required": ["text"]
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
            "description": "A special tool to indicate you have completed all tasks and are about to enter complete state. Use ONLY when: 1) All tasks in todo.md are marked complete [x], 2) The user's original request has been fully addressed, 3) There are no pending actions or follow-ups required, 4) You've delivered all final outputs and results to the user. IMPORTANT: This is the ONLY way to properly terminate execution. Never use this tool unless ALL tasks are complete and verified. Always ensure you've provided all necessary outputs and references before using this tool. Include relevant attachments when the completion relates to specific files or resources.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Completion message or summary to present to user - should provide clear indication of what was accomplished. Include: 1) Summary of completed tasks, 2) Key deliverables or outputs, 3) Any important notes or next steps, 4) Impact or benefits achieved."
                    },
                    "attachments": {
                        "anyOf": [
                            {"type": "string"},
                            {"items": {"type": "string"}, "type": "array"}
                        ],
                        "description": "(Optional) List of files or URLs to attach to the completion message. Include when: 1) Completion relates to specific files or configurations, 2) User needs to review final outputs, 3) Deliverables are documented in files, 4) Supporting evidence or context is needed. Always use relative paths to /workspace directory. **For presentations**: When attaching presentation files, only attach the first slide (e.g., `presentations/[name]/slide_01.html`) to keep the UI tidy - the presentation card will automatically show the full presentation. You can also attach `presentations/[name]/metadata.json` if needed."
                    },
                    "follow_up_prompts": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "(Optional) List of suggested follow-up prompts the user can click to continue working. CRITICAL GUIDELINES: 1) Make prompts SPECIFIC to what was just completed - reference actual file names, components, features, or deliverables created, 2) Suggest logical NEXT STEPS that build on the completed work (e.g., 'Add unit tests for the UserService class' not 'Write tests'), 3) Include specific details from the task (e.g., 'Deploy the dashboard to production' not 'Deploy the app'), 4) Think about what the user would NATURALLY want to do next with this specific output, 5) Reference created files/features by name (e.g., 'Add authentication to the /api/users endpoint' not 'Add auth'), 6) Avoid generic prompts - make them actionable and task-aware. GOOD EXAMPLES for a completed API: 'Add rate limiting to the new /api/orders endpoint', 'Create a Postman collection for testing the order API', 'Add error handling for the payment processing flow'. GOOD EXAMPLES for a completed UI: 'Make the dashboard mobile-responsive', 'Add loading states to the data tables', 'Implement dark mode for the settings page'. BAD EXAMPLES: 'Improve the code', 'Add more features', 'Test the application', 'Make it better'. Maximum 4 suggestions, each should clearly describe a specific actionable task."
                    }
                },
                "required": []
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
            "description": "Pause execution for a specified number of seconds. Use this tool to add deliberate pauses in long-running processes to prevent rushing and maintain a steady, thoughtful pace. This helps prevent errors and ensures quality execution.",
            "parameters": {
                "type": "object",
                "properties": {
                    "seconds": {
                        "type": "integer",
                        "description": "Number of seconds to wait (1-300 seconds). Use 1-3 seconds for brief pauses, 5-10 seconds for processing waits, 60+ seconds for longer operations.",
                        "minimum": 1,
                        "maximum": 300
                    }
                },
                "required": ["seconds"]
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
