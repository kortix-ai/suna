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
    visible=True
)
class MessageTool(Tool):
    """Tool for user communication and interaction.
    """

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
                        "description": "(Optional) List of suggested follow-up answers or responses the user can click to respond quickly. Use when: 1) There are common or likely responses, 2) You want to guide the user toward specific options, 3) Quick responses would improve UX. Each answer can be a short phrase or a more descriptive sentence that clearly communicates the user's intent. Examples: \"Yes, proceed with that approach\", \"No, let's cancel this and try a different method\", \"I'd prefer Option A because it aligns better with our goals\", \"Let me review the details and get back to you\". Longer, more descriptive answers are encouraged as they provide better context. Maximum 4 suggestions."
                    }
                },
                "required": ["text"]
            }
        }
    })
    async def ask(self, text: str, attachments: Optional[Union[str, List[str]]] = None, follow_up_answers: Optional[List[str]] = None) -> ToolResult:
        """Ask the user a question and wait for a response.

        Args:
            text: The question to present to the user
            attachments: Optional file paths or URLs to attach to the question
            follow_up_answers: Optional list of suggested follow-up answers

        Returns:
            ToolResult indicating the question was successfully sent
        """
        try:            
            # Convert single attachment to list for consistent handling
            if attachments and isinstance(attachments, str):
                attachments = [attachments]
          
            return self.success_response({"status": "Awaiting user response..."})
        except Exception as e:
            return self.fail_response(f"Error asking user: {str(e)}")


#     @openapi_schema({
#         "type": "function",
#         "function": {
#             "name": "inform",
#             "description": "Inform the user about progress, completion of a major step, or important context. Use this tool: 1) To provide updates between major sections of work, 2) After accomplishing significant milestones, 3) When transitioning to a new phase of work, 4) To confirm actions were completed successfully, 5) To provide context about upcoming steps. IMPORTANT: Use FREQUENTLY throughout execution to provide UI context to the user. The user CANNOT respond to this tool - they can only respond to the 'ask' tool. Use this tool to keep the user informed without requiring their input.",
#             "parameters": {
#                 "type": "object",
#                 "properties": {
#                     "text": {
#                         "type": "string",
#                         "description": "Information to present to the user. Include: 1) Clear statement of what has been accomplished or what is happening, 2) Relevant context or impact, 3) Brief indication of next steps if applicable."
#                     },
#                     "attachments": {
#                         "anyOf": [
#                             {"type": "string"},
#                             {"items": {"type": "string"}, "type": "array"}
#                         ],
#                         "description": "(Optional) List of files or URLs to attach to the information. Include when: 1) Information relates to specific files or resources, 2) Showing intermediate results or outputs, 3) Providing supporting documentation. Always use relative paths to /workspace directory."
#                     }
#                 },
#                 "required": ["text"]
#             }
#         }
#     })
#     @xml_schema(
#         tag_name="inform",
#         mappings=[
#             {"param_name": "text", "node_type": "content", "path": "."},
#             {"param_name": "attachments", "node_type": "attribute", "path": ".", "required": False}
#         ],
#         example='''

# Inform the user about progress, completion of a major step, or important context. Use this tool: 1) To provide updates between major sections of work, 2) After accomplishing significant milestones, 3) When transitioning to a new phase of work, 4) To confirm actions were completed successfully, 5) To provide context about upcoming steps. IMPORTANT: Use FREQUENTLY throughout execution to provide UI context to the user. The user CANNOT respond to this tool - they can only respond to the 'ask' tool. Use this tool to keep the user informed without requiring their input."

#         <!-- Use inform FREQUENTLY to provide UI context and progress updates - THE USER CANNOT RESPOND to this tool -->
#         <!-- The user can ONLY respond to the ask tool, not to inform -->
#         <!-- Examples of when to use inform: -->
#         <!-- 1. Completing major milestones -->
#         <!-- 2. Transitioning between work phases -->
#         <!-- 3. Confirming important actions -->
#         <!-- 4. Providing context about upcoming steps -->
#         <!-- 5. Sharing significant intermediate results -->
#         <!-- 6. Providing regular UI updates throughout execution -->

#         <inform attachments="analysis_results.csv,summary_chart.png">
#             I've completed the data analysis of the sales figures. Key findings include:
#             - Q4 sales were 28% higher than Q3
#             - Product line A showed the strongest performance
#             - Three regions missed their targets

#             I'll now proceed with creating the executive summary report based on these findings.
#         </inform>
#         '''
#     )
#     async def inform(self, text: str, attachments: Optional[Union[str, List[str]]] = None) -> ToolResult:
#         """Inform the user about progress or important updates without requiring a response.

#         Args:
#             text: The information to present to the user
#             attachments: Optional file paths or URLs to attach

#         Returns:
#             ToolResult indicating the information was successfully sent
#         """
#         try:
#             # Convert single attachment to list for consistent handling
#             if attachments and isinstance(attachments, str):
#                 attachments = [attachments]

#             return self.success_response({"status": "Information sent"})
#         except Exception as e:
#             return self.fail_response(f"Error informing user: {str(e)}")


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
                        "description": "(Optional) List of suggested follow-up prompts the user can click to continue working. Use when: 1) There are logical next steps or related tasks, 2) You want to guide the user toward useful follow-up actions, 3) Quick prompts would improve UX. Each prompt should be a clear, actionable request that describes what the user wants to accomplish. Longer, more descriptive prompts are encouraged as they provide better context and clarity. Examples: \"Generate a detailed speaker script for the presentation with talking points for each slide\", \"Create a comprehensive summary document that highlights the key findings and recommendations\", \"Explore this topic in more depth by researching recent developments and industry trends\", \"Refine the design to match our brand guidelines and improve the user experience\". Maximum 4 suggestions."
                    }
                },
                "required": []
            }
        }
    })
    async def complete(self, text: Optional[str] = None, attachments: Optional[Union[str, List[str]]] = None, follow_up_prompts: Optional[List[str]] = None) -> ToolResult:
        """Indicate that the agent has completed all tasks and is entering complete state.

        Args:
            text: Optional completion message or summary to present to the user
            attachments: Optional file paths or URLs to attach to the completion message
            follow_up_prompts: Optional list of suggested follow-up prompts

        Returns:
            ToolResult indicating successful transition to complete state
        """
        try:
            # Convert single attachment to list for consistent handling
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
        """Pause execution for a specified number of seconds.

        Args:
            seconds: Number of seconds to wait (1-300)

        Returns:
            ToolResult indicating the wait was completed
        """
        try:
            # Validate duration
            if seconds < 1 or seconds > 300:
                return self.fail_response("Duration must be between 1 and 300 seconds")
            
            # Import asyncio for the sleep
            import asyncio
            
            # Log the wait
            logger.info(f"Agent waiting {seconds} seconds")
            
            # Perform the wait
            await asyncio.sleep(seconds)
            
            # Return success
            return self.success_response(f"Waited {seconds} seconds")
            
        except Exception as e:
            return self.fail_response(f"Error during wait: {str(e)}")


if __name__ == "__main__":
    import asyncio

    async def test_message_tool():
        message_tool = MessageTool()

        # Test question
        ask_result = await message_tool.ask(
            text="Would you like to proceed with the next phase?",
            attachments="summary.pdf"
        )
        print("Question result:", ask_result)

        # Test inform
        inform_result = await message_tool.inform(
            text="Completed analysis of data. Processing results now.",
            attachments="analysis.pdf"
        )
        print("Inform result:", inform_result)

    asyncio.run(test_message_tool())
