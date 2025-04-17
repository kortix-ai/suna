import asyncio
import litellm

async def main():
    initial_messages=[
        # System Message
        {
            "role": "system",
            "content": [
                {
                    "type": "text",
                    "text": "Here is the full text of a complex legal agreement"
                    * 400,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
        },
        # marked for caching with the cache_control parameter, so that this checkpoint can read from the previous cache.
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "What are the key terms and conditions in this agreement?",
                    "cache_control": {"type": "ephemeral"},
                }
            ],
        },
        {
            "role": "assistant",
            "content": "Certainly! the key terms and conditions are the following: the contract is 1 year long for $10/month",
        },
        # The final turn is marked with cache-control, for continuing in followups.
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "What are the key terms and conditions in this agreement?",
                    "cache_control": {"type": "ephemeral"},
                }
            ],
        },
    ]

    print("--- First call ---")
    first_response = await litellm.acompletion(
        model="anthropic/claude-3-7-sonnet-latest",
        messages=initial_messages
    )
    print(first_response)

    # Prepare messages for the second call
    second_call_messages = initial_messages + [
        {
            "role": "assistant",
            # Extract the assistant's response content from the first call
            "content": first_response.choices[0].message.content 
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "Can you elaborate on the termination clause based on the provided text? Remember the context.",
                    "cache_control": {"type": "ephemeral"}, # Mark for caching
                }
            ],
        },
    ]

    print("\n--- Second call (testing cache) ---")
    second_response = await litellm.acompletion(
        model="anthropic/claude-3-7-sonnet-latest",
        messages=second_call_messages
    )
    print(second_response)

if __name__ == "__main__":
    asyncio.run(main())


