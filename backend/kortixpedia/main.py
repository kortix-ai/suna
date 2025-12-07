from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
import httpx
from core.services import llm
from core.utils.logger import logger
from core.utils.config import config
import json

router = APIRouter(tags=["Kortixpedia"])

# ============ IMAGE SEARCH ============
async def search_images(query: str, num_results: int = 8) -> list[str]:
    """Search for images using SERPER API."""
    if not config.SERPER_API_KEY:
        return []
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://google.serper.dev/images",
                json={"q": query, "num": num_results},
                headers={"X-API-KEY": config.SERPER_API_KEY, "Content-Type": "application/json"},
                timeout=10.0
            )
            response.raise_for_status()
            images = response.json().get("images", [])
            return [img.get("imageUrl") for img in images if img.get("imageUrl") and not img.get("imageUrl", "").endswith('.svg')][:num_results]
    except Exception as e:
        logger.error(f"Image search error: {e}")
        return []


# ============ DYNAMIC LAYOUT PLANNER ============
PLANNER_SYSTEM_PROMPT = """You create educational pages with DYNAMIC, VARIED layouts. NOT all same-type cells grouped together.

OUTPUT ONLY VALID XML. No markdown. Start with <page>.

CRITICAL LAYOUT RULES:
1. NEVER put all stats together - spread them throughout the page
2. ALTERNATE between large sections and small cells
3. Create visual rhythm: section → 2 small cells → section → 1 stat + 1 fact → etc.
4. The page should feel like reading a well-designed magazine, not a data dump

EXAMPLE FLOW (vary this based on topic):
- Overview section (full width)
- 1 stat + 1 key fact (half width each)
- How It Works section (full width) 
- 2-3 component cards (quarter/half width)
- 1 stat + deep insight (half width each)
- Applications section (full width)
- Pros + Cons (half width each)
- 1 stat + timeline intro (quarter + three-quarter)
- History section (full width)
- Resources (2 half-width cards)

XML STRUCTURE:
<page>
  <title>Clear Topic Title</title>
  <subtitle>One compelling sentence</subtitle>
  
  <toc>
    <section id="overview" title="Overview" />
    <section id="how-it-works" title="How It Works" />
    <section id="components" title="Key Parts" />
    <section id="deep-dive" title="Deep Dive" />
    <section id="applications" title="Applications" />
    <section id="history" title="History" />
  </toc>
  
  <grid>
    <!-- INTRO: Overview first -->
    <cell id="overview" cols="4" type="section" tokens="400">
      <title>What is [Topic]?</title>
      <desc>Clear introduction explaining what it is and why it matters.</desc>
    </cell>
    
    <!-- MIXED ROW: Stat + Fact -->
    <cell id="stat1" cols="2" type="stat" tokens="100">
      <title>Key Number</title>
      <desc>Important metric</desc>
    </cell>
    <cell id="keypoint1" cols="2" type="fact" tokens="200">
      <title>Key Point</title>
      <desc>Important concept</desc>
    </cell>
    
    <!-- MAIN SECTION: How it works -->
    <cell id="how-it-works" cols="4" type="steps" tokens="700">
      <title>How [Topic] Works</title>
      <desc>Step-by-step A-to-Z explanation</desc>
    </cell>
    
    <!-- COMPONENTS ROW: Mixed sizes -->
    <cell id="part1" cols="1" type="component" tokens="120">
      <title>Part 1</title>
      <desc>Key component</desc>
    </cell>
    <cell id="part2" cols="1" type="component" tokens="120">
      <title>Part 2</title>
      <desc>Key component</desc>
    </cell>
    <cell id="stat2" cols="2" type="stat" tokens="100">
      <title>Another Metric</title>
      <desc>Relevant number</desc>
    </cell>
    
    <!-- DEEP SECTION -->
    <cell id="deep-dive" cols="4" type="section" tokens="450">
      <title>Understanding [Detail]</title>
      <desc>Deeper technical explanation</desc>
    </cell>
    
    <!-- INSIGHT ROW -->
    <cell id="insight1" cols="2" type="fact" tokens="200">
      <title>Key Insight</title>
      <desc>Important takeaway</desc>
    </cell>
    <cell id="stat3" cols="2" type="stat" tokens="100">
      <title>Impact Metric</title>
      <desc>Measurable result</desc>
    </cell>
    
    <!-- COMPARISON -->
    <cell id="pros" cols="2" type="pros" tokens="200">
      <title>Advantages</title>
      <desc>Benefits</desc>
    </cell>
    <cell id="cons" cols="2" type="cons" tokens="200">
      <title>Limitations</title>
      <desc>Challenges</desc>
    </cell>
    
    <!-- APPLICATIONS -->
    <cell id="applications" cols="4" type="section" tokens="400">
      <title>Real-World Applications</title>
      <desc>Practical uses and examples</desc>
    </cell>
    
    <!-- HISTORY with stat -->
    <cell id="stat4" cols="1" type="stat" tokens="80">
      <title>Year Started</title>
      <desc>Origin date</desc>
    </cell>
    <cell id="history" cols="3" type="timeline" tokens="350">
      <title>History & Evolution</title>
      <desc>Key milestones</desc>
    </cell>
    
    <!-- RESOURCES -->
    <cell id="learn" cols="2" type="resource" tokens="150">
      <title>Learn More</title>
      <desc>Resources</desc>
    </cell>
    <cell id="start" cols="2" type="resource" tokens="150">
      <title>Get Started</title>
      <desc>First steps</desc>
    </cell>
  </grid>
</page>

CELL TYPES:
- stat: Big number (80-100 tokens) - SPREAD THESE OUT, don't group
- fact: Quick insight card (150-200 tokens)
- component: Part/element (100-150 tokens)
- section: In-depth content (400-500 tokens)
- steps: A-to-Z guide (600-800 tokens)
- timeline: Chronological (300-400 tokens)
- pros/cons: Lists (150-200 tokens)
- resource: Next steps (100-150 tokens)

COLS: 1=quarter, 2=half, 3=three-quarter, 4=full

REMEMBER: Create VISUAL VARIETY. Never group same types. Alternate big/small cells."""


# ============ CONTENT GENERATOR ============
CONTENT_SYSTEM_PROMPT = """Generate clean educational HTML content.

OUTPUT: <div class="kp-cell">...<style>...</style></div>. NO markdown.

CSS Variables: --kp-text, --kp-muted, --kp-primary, --kp-card, --kp-border

STYLES BY TYPE:

STAT: Center a large number (2.5rem), label below, subtle gradient bg
FACT: Bold title, 2-3 bullet points or short paragraph
COMPONENT: Emoji + title + 2-sentence description
SECTION: h2 title, 2-3 paragraphs, bold key terms
STEPS: Numbered steps with colored circles, title + explanation each
TIMELINE: Vertical line, year badges, events
PROS: Green ✓ items with brief text
CONS: Red ✗ items with brief text  
RESOURCE: Card with icon, action items

Keep it scannable, educational, well-spaced."""


# ============ API ENDPOINTS ============

@router.get("/explore/{topic}", summary="Stream knowledge page", operation_id="explore_topic")
async def explore_topic(topic: str):
    """Stream structured layout XML with images."""
    logger.info(f"📋 Generating dynamic page for: {topic}")
    
    images = await search_images(f"{topic} explained diagram", num_results=8)
    logger.info(f"🖼️ Found {len(images)} images")
    
    messages = [
        {"role": "system", "content": PLANNER_SYSTEM_PROMPT},
        {"role": "user", "content": f"Create a comprehensive, visually varied educational page about: {topic}"}
    ]

    try:
        llm_response = await llm.make_llm_api_call(
            messages=messages,
            model_name="groq/moonshotai/kimi-k2-instruct",
            temperature=0.8,  # Slightly higher for more variety
            max_tokens=2500,
            stream=True,
        )

        async def stream_generator():
            yield f"data: {json.dumps({'type': 'images', 'images': images, 'count': len(images)})}\n\n"
            try:
                async for chunk in llm_response:
                    if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                        yield f"data: {json.dumps({'type': 'content', 'content': chunk.choices[0].delta.content})}\n\n"
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
            except Exception as e:
                logger.error(f"Stream error: {e}")
                yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*"}
        )
    except Exception as e:
        logger.error(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/explore/content/{cell_id}", summary="Stream cell content", operation_id="generate_cell_content")
async def generate_cell_content(
    cell_id: str,
    title: str,
    description: str,
    type: str = "text",
    cols: str = "2",
    tokens: str = "300",
    topic: str = ""
):
    """Generate HTML content for a cell."""
    max_tokens = min(int(tokens), 1200) if tokens.isdigit() else 300
    logger.info(f"🎨 Cell {cell_id}: {title} ({type}, {cols} cols, {max_tokens} tokens)")

    type_instructions = {
        "stat": "Large centered number (2.5rem), label below, subtle gradient background.",
        "fact": "Bold title, 2-3 concise bullet points. Clean scannable format.",
        "component": "Emoji icon + bold title + 2-sentence description. Card style.",
        "section": "h2 title, 2-3 paragraphs with bold key terms. Educational depth.",
        "steps": "Numbered steps (Step 1, Step 2...) with colored circle numbers. Each: bold title + explanation. 5-7 steps.",
        "timeline": "Vertical timeline with year badges on left, event descriptions. 4-6 milestones.",
        "pros": "Green checkmarks (✓), 4-5 benefit items with brief text.",
        "cons": "Red x marks (✗), 4-5 limitation items with brief text.",
        "resource": "Card with emoji, title, 3-4 action items or resources.",
    }

    user_prompt = f"""Create {type.upper()} content for "{topic}":
Title: {title}
Description: {description}

{type_instructions.get(type, "Create clear educational content.")}

Start with <div class="kp-cell">, include <style>, end with </div>."""

    messages = [
        {"role": "system", "content": CONTENT_SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt}
    ]

    try:
        llm_response = await llm.make_llm_api_call(
            messages=messages,
            model_name="groq/moonshotai/kimi-k2-instruct",
            temperature=0.7,
            max_tokens=max_tokens,
            stream=True,
        )

        async def stream_generator():
            try:
                async for chunk in llm_response:
                    if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                        yield f"data: {json.dumps({'type': 'content', 'content': chunk.choices[0].delta.content, 'cell_id': cell_id})}\n\n"
                yield f"data: {json.dumps({'type': 'done', 'cell_id': cell_id})}\n\n"
            except Exception as e:
                logger.error(f"Stream error {cell_id}: {e}")
                yield f"data: {json.dumps({'type': 'error', 'message': str(e), 'cell_id': cell_id})}\n\n"

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*"}
        )
    except Exception as e:
        logger.error(f"Error cell {cell_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
