"""Test to see Bedrock streaming chunk structure"""
import asyncio
from litellm import acompletion

async def test_bedrock_usage():
    """Test Bedrock streaming to see chunk structure and usage data"""
    
    messages = [{"role": "user", "content": "Say hello"}]
    
    model = "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/heol2zyy5v48"
    
    print("=" * 80)
    print("Testing Bedrock Converse streaming chunk structure")
    print("=" * 80)
    
    chunk_count = 0
    usage_found = False
    
    response = await acompletion(
        model=model,
        messages=messages,
        stream=True,
        temperature=0
    )
    
    async for chunk in response:
        chunk_count += 1
        
        # Print first few chunks in detail
        if chunk_count <= 3:
            print(f"\n--- Chunk #{chunk_count} ---")
            print(f"Type: {type(chunk)}")
            print(f"Attributes: {dir(chunk)}")
            print(f"Has 'usage': {hasattr(chunk, 'usage')}")
            if hasattr(chunk, 'usage'):
                print(f"Usage value: {chunk.usage}")
            print(f"Chunk: {chunk}")
        
        # Check for usage
        if hasattr(chunk, 'usage') and chunk.usage:
            usage_found = True
            print(f"\n🎯 USAGE FOUND in chunk #{chunk_count}!")
            print(f"Usage: {chunk.usage}")
    
    print(f"\n" + "=" * 80)
    print(f"Total chunks: {chunk_count}")
    print(f"Usage found: {usage_found}")
    print("=" * 80)

if __name__ == "__main__":
    asyncio.run(test_bedrock_usage())
