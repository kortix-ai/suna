from typing import List, Optional, Union
from agentpress.tool import Tool, ToolResult, openapi_schema, usage_example
from utils.logger import logger

class MessageTool(Tool):
    """Tool for user communication and interaction.

    This tool provides methods for asking questions, with support for
    attachments and user takeover suggestions.
    """

    def __init__(self):
        super().__init__()

    # Commented out as we are just doing this via prompt as there is no need to call it as a tool

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
                    }
                },
                "required": ["text"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="ask">
        <parameter name="text">I'm planning to bake the chocolate cake for your birthday party. The recipe mentions "rich frosting" but doesn't specify what type. Could you clarify your preferences? For example:
1. Would you prefer buttercream or cream cheese frosting?
2. Do you want any specific flavor added to the frosting (vanilla, coffee, etc.)?
3. Should I add any decorative toppings like sprinkles or fruit?
4. Do you have any dietary restrictions I should be aware of?

This information will help me make sure the cake meets your expectations for the celebration.</parameter>
        <parameter name="attachments">recipes/chocolate_cake.txt,photos/cake_examples.jpg</parameter>
        </invoke>
        </function_calls>
        ''')
    async def ask(self, text: str, attachments: Optional[Union[str, List[str]]] = None) -> ToolResult:
        """Ask the user a question and wait for a response.

        Args:
            text: The question to present to the user
            attachments: Optional file paths or URLs to attach to the question

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

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "web_browser_takeover",
            "description": "Request user takeover of browser interaction. Use this tool when: 1) The page requires complex human interaction that automated tools cannot handle, 2) Authentication or verification steps require human input, 3) The page has anti-bot measures that prevent automated access, 4) Complex form filling or navigation is needed, 5) The page requires human verification (CAPTCHA, etc.). IMPORTANT: This tool should be used as a last resort after web-search and crawl-webpage have failed, and when direct browser tools are insufficient. Always provide clear context about why takeover is needed and what actions the user should take.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Instructions for the user about what actions to take in the browser. Include: 1) Clear explanation of why takeover is needed, 2) Specific steps the user should take, 3) What information to look for or extract, 4) How to indicate when they're done, 5) Any important context about the current page state."
                    },
                    "attachments": {
                        "anyOf": [
                            {"type": "string"},
                            {"items": {"type": "string"}, "type": "array"}
                        ],
                        "description": "(Optional) List of files or URLs to attach to the takeover request. Include when: 1) Screenshots or visual references are needed, 2) Previous search results or crawled content is relevant, 3) Supporting documentation is required. Always use relative paths to /workspace directory."
                    }
                },
                "required": ["text"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="web_browser_takeover">
        <parameter name="text">I've encountered a CAPTCHA verification on the page that I can't solve automatically. Could you help me out?

Here's what I need you to do:
1. Solve the CAPTCHA puzzle that's currently displayed
2. Let me know once you've completed it
3. I'll then continue with the automated process

If you encounter any issues or need to take additional steps, please let me know. Thanks for your help!</parameter>
        </invoke>
        </function_calls>
        ''')
    async def web_browser_takeover(self, text: str, attachments: Optional[Union[str, List[str]]] = None) -> ToolResult:
        """Request user takeover of browser interaction.

        Args:
            text: Instructions for the user about what actions to take
            attachments: Optional file paths or URLs to attach to the request

        Returns:
            ToolResult indicating the takeover request was successfully sent
        """
        try:
            # Convert single attachment to list for consistent handling
            if attachments and isinstance(attachments, str):
                attachments = [attachments]

            return self.success_response({"status": "Awaiting user browser takeover..."})
        except Exception as e:
            return self.fail_response(f"Error requesting browser takeover: {str(e)}")

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
                        "description": "(Optional) List of files or URLs to attach to the completion message. Include when: 1) Completion relates to specific files or configurations, 2) User needs to review final outputs, 3) Deliverables are documented in files, 4) Supporting evidence or context is needed. Always use relative paths to /workspace directory."
                    }
                },
                "required": []
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="complete">
        <parameter name="text">I have successfully completed all tasks for your project. Here's what was accomplished:
1. Created the web application with modern UI components
2. Implemented user authentication and database integration
3. Deployed the application to production
4. Created comprehensive documentation

All deliverables are attached for your review.</parameter>
        <parameter name="attachments">app/src/main.js,docs/README.md,deployment-config.yaml</parameter>
        </invoke>
        </function_calls>
        ''')
    async def complete(self, text: Optional[str] = None, attachments: Optional[Union[str, List[str]]] = None) -> ToolResult:
        """Indicate that the agent has completed all tasks and is entering complete state.

        Args:
            text: Optional completion message or summary to present to the user
            attachments: Optional file paths or URLs to attach to the completion message

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
