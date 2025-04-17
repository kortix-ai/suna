import asyncio
import litellm
import copy
import json
from dotenv import load_dotenv

load_dotenv()

async def run_conversation_turn(model: str, messages: list, user_prompt: str | list, reasoning_effort: str | None = None):
    """
    Handles a single turn of the conversation, prepares arguments, and calls litellm.acompletion.

    Args:
        model: The model name string.
        messages: The list of message dictionaries (will be modified in place).
        user_prompt: The user's prompt for this turn (string or list).
        reasoning_effort: Optional reasoning effort string for Anthropic models.

    Returns:
        The response object from litellm.acompletion.
    """
    # Append user prompt
    if isinstance(user_prompt, str):
         messages.append({"role": "user", "content": user_prompt})
    elif isinstance(user_prompt, list): # Handle list/dict content structure
        messages.append({"role": "user", "content": user_prompt})

    # --- Start of merged logic from call_litellm_with_cache ---
    processed_messages = copy.deepcopy(messages) # Work on a copy for modification
    is_anthropic = model.startswith("anthropic")
    kwargs = {
        "model": model,
        "messages": processed_messages,
    }

    call_description = [f"Calling {model}", f"{len(processed_messages)} messages"]

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
        call_description.append("cache enabled")

        # Add reasoning_effort only for Anthropic models if provided
        if reasoning_effort:
            kwargs["reasoning_effort"] = reasoning_effort
            call_description.append(f"reasoning: {reasoning_effort}")

    print(f"\n--- {' | '.join(call_description)} ---")

    response = await litellm.acompletion(**kwargs)

    print("--- Full Response Object ---")
    # Convert response object to dict and print as indented JSON
    try:
        print(json.dumps(response.dict(), indent=2))
        print(response._hidden_params)
    except Exception as e:
        print(f"Could not format response as JSON: {e}")
        print(response) # Fallback to printing the raw object if conversion fails
    print("--- End Response ---")
    # --- End of merged logic ---


    # Append assistant response to the original messages list
    if response.choices and response.choices[0].message.content:
        messages.append({
            "role": "assistant",
            "content": response.choices[0].message.content
        })
    else:
        # Handle cases where response might be empty or malformed
        print("Warning: Assistant response content is missing.")
        messages.append({"role": "assistant", "content": ""}) # Append empty content

    return response

async def main(model_name: str, reasoning_effort: str = "medium"):
    hello_string = "Hello " * 1234

    # Initial messages
    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": f"Here is some text: {hello_string}"},
        {"role": "assistant", "content": "Okay, I have received the text."},
    ]

    # Turn 1: Ask to count "Hello"
    print("\n=== Turn 1: Counting 'Hello' ===")
    await run_conversation_turn(
        model=model_name,
        messages=messages,
        user_prompt="How many times does the word 'Hello' appear in the text I provided?",
        reasoning_effort=reasoning_effort,
    )

    # Turn 2: Ask for a short story
    print("\n=== Turn 2: Short Story Request ===")
    await run_conversation_turn(
        model=model_name,
        messages=messages,
        user_prompt=[ # Using list/dict format for user content
            {
                "type": "text",
                "text": "Great, thanks for counting. Now, can you write a short story (less than 50 words) where the word 'Hello' appears exactly 5 times?",
            }
        ],
        reasoning_effort=reasoning_effort,
    )

    # Turn 3: Ask about the main character
    print("\n=== Turn 3: Main Character Question ===")
    await run_conversation_turn(
        model=model_name,
        messages=messages,
        user_prompt=[ # Using list/dict format for user content
            {
                "type": "text",
                "text": "Based on the short story you just wrote, who is the main character?",
            }
        ],
        reasoning_effort=reasoning_effort,
    )

if __name__ == "__main__":
    # Select the model to test
    model = "anthropic/claude-3-7-sonnet-latest"
    # model = "groq/llama-3.3-70b-versatile"
    # model = "openai/gpt-4o-mini"
    # model = "openai/gpt-4.1-2025-04-14" # Placeholder if needed

    print(f"Running test with model: {model}")
    asyncio.run(main(
        model_name=model,
        # reasoning_effort="medium"
        reasoning_effort="low"
    ))


