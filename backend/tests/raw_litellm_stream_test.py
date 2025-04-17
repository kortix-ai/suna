import asyncio
import litellm
import copy
import json
from dotenv import load_dotenv

load_dotenv()

async def run_streaming_conversation_turn(model: str, messages: list, user_prompt: str | list, enable_thinking: bool = False, reasoning_effort: str | None = None):
    """
    Handles a single turn of the conversation using streaming, prepares arguments,
    and calls litellm.acompletion with stream=True.

    Args:
        model: The model name string.
        messages: The list of message dictionaries (will be modified in place).
        user_prompt: The user's prompt for this turn (string or list).
        enable_thinking: Boolean to enable thinking for Anthropic models.
        reasoning_effort: Optional reasoning effort string for Anthropic models.

    Returns:
        The final accumulated assistant response dictionary.
    """
    # Append user prompt
    if isinstance(user_prompt, str):
        messages.append({"role": "user", "content": user_prompt})
    elif isinstance(user_prompt, list): # Handle list/dict content structure
        messages.append({"role": "user", "content": user_prompt})

    processed_messages = copy.deepcopy(messages) # Work on a copy for modification
    is_anthropic = model.startswith("anthropic")
    kwargs = {
        "model": model,
        "messages": processed_messages,
        "stream": True, # Enable streaming
    }


    if is_anthropic:
        # Add cache_control for Anthropic models
        if processed_messages and processed_messages[0]["role"] == "system":
            content = processed_messages[0].get("content")
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict):
                        part["cache_control"] = {"type": "ephemeral"}
            elif isinstance(content, str):
                processed_messages[0]["content"] = [{"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}]

        if processed_messages and processed_messages[-1]["role"] == "user":
            content = processed_messages[-1].get("content")
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict):
                        part["cache_control"] = {"type": "ephemeral"}
            elif isinstance(content, str):
                processed_messages[-1]["content"] = [{"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}]

        # Add reasoning_effort only for Anthropic models if provided and thinking is enabled
        if enable_thinking and reasoning_effort:
            kwargs["reasoning_effort"] = reasoning_effort

    stream_response = await litellm.acompletion(**kwargs)
    
    # Collect the full response from streaming chunks
    full_response_content = ""
    thinking_printed = False
    response_printed = False
    async for chunk in stream_response:
        if chunk.choices and chunk.choices[0].delta:
            delta = chunk.choices[0].delta

            # Print thinking/reasoning content if present
            if hasattr(delta, "reasoning_content") and delta.reasoning_content:
                if not thinking_printed:
                    print("[Thinking]: ", end="", flush=True)
                    thinking_printed = True
                print(f"{delta.reasoning_content}", end="", flush=True) # Print thinking step

            # Print and accumulate regular content
            if delta.content:
                if not response_printed:
                    # Add newline if thinking was printed before response starts
                    if thinking_printed:
                        print() # Newline to separate thinking and response
                    print("[Response]: ", end="", flush=True)
                    response_printed = True
                chunk_content = delta.content
                full_response_content += chunk_content
                # Stream to stdout in real-time
                print(chunk_content, end="", flush=True)

    print() # Newline after streaming finishes

    # Print hidden params if available
    try:
        print("--- Hidden Params ---")
        print(stream_response._hidden_params)
        print("--- End Hidden Params ---")
    except AttributeError:
        print("(_hidden_params attribute not found on stream response object)")
    except Exception as e:
        print(f"Could not print _hidden_params: {e}")

    print("--------------------------------")
    print() # Add another newline for separation
    
    # Create a complete response object with the full content
    final_response = {
        "model": model,
        "choices": [{
            "message": {"role": "assistant", "content": full_response_content}
        }]
    }
    
    # Add the assistant's response to the messages
    messages.append({"role": "assistant", "content": full_response_content})
    
    return final_response


async def main(model_name: str, enable_thinking: bool = False, reasoning_effort: str = "medium"):
    """Runs a multi-turn conversation test with streaming enabled."""
    hello_string = "Hello " * 1234

    # Initial messages
    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": f"Here is some text: {hello_string}"},
        {"role": "assistant", "content": "Okay, I have received the text."},
    ]

    # Turn 1: Ask to count "Hello"
    await run_streaming_conversation_turn(
        model=model_name,
        messages=messages,
        user_prompt="How many times does the word 'Hello' appear in the text I provided?",
        enable_thinking=enable_thinking,
        reasoning_effort=reasoning_effort,
    )

    # Turn 2: Ask for a short story
    await run_streaming_conversation_turn(
        model=model_name,
        messages=messages,
        user_prompt=[ # Using list/dict format for user content
            {
                "type": "text",
                "text": "Great, thanks for counting. Now, can you write a short story (less than 50 words) where the word 'Hello' appears exactly 5 times?",
            }
        ],
        enable_thinking=enable_thinking,
        reasoning_effort=reasoning_effort,
    )

    # Turn 3: Ask about the main character
    await run_streaming_conversation_turn(
        model=model_name,
        messages=messages,
        user_prompt=[ # Using list/dict format for user content
            {
                "type": "text",
                "text": "Based on the short story you just wrote, who is the main character?",
            }
        ],
        enable_thinking=enable_thinking,
        reasoning_effort=reasoning_effort,
    )

if __name__ == "__main__":
    # Select the model to test
    model = "anthropic/claude-3-7-sonnet-latest"
    # model = "openai/gpt-4o-mini"
    # model = "openai/gpt-4.1-2025-04-14" # Placeholder if needed

    asyncio.run(main(
        model_name=model,
        enable_thinking=True, # Enable thinking for the test run
        # reasoning_effort="medium"
        reasoning_effort="low" # Start with low for faster responses
    )) 