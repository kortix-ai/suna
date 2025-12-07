from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from core.services import llm
from core.utils.logger import logger
import json

router = APIRouter(tags=["Kortixpedia"])

# System prompt for the PLANNER - Wikipedia-style grid layout with info boxes
PLANNER_SYSTEM_PROMPT = """You are a knowledge page layout planner creating Wikipedia-style educational pages.

OUTPUT ONLY VALID XML. No explanations, no markdown, just pure XML starting with <page>.

Structure:
<page>
  <title>Page Title</title>
  <subtitle>Brief one-line description</subtitle>
  <infobox>
    <item label="Category">Value</item>
    <item label="Type">Value</item>
    <item label="Key Fact">Value</item>
    <item label="Related">Value</item>
  </infobox>
  <intro>One paragraph introduction/summary of the topic</intro>
  <toc>
    <entry id="1">Section Name</entry>
    <entry id="2">Section Name</entry>
  </toc>
  <grid>
    <cell id="1" size="full" type="text">
      <title>Overview</title>
      <desc>Main overview content</desc>
    </cell>
    <cell id="2" size="half" type="diagram">
      <title>How It Works</title>
      <desc>Visual explanation</desc>
    </cell>
    <cell id="3" size="half" type="stats">
      <title>Key Numbers</title>
      <desc>Important statistics</desc>
    </cell>
    <cell id="4" size="third" type="fact">
      <title>Quick Fact</title>
      <desc>Interesting tidbit</desc>
    </cell>
    <cell id="5" size="third" type="fact">
      <title>Did You Know?</title>
      <desc>Another fact</desc>
    </cell>
    <cell id="6" size="third" type="list">
      <title>Related Topics</title>
      <desc>Links and references</desc>
    </cell>
    <cell id="7" size="full" type="timeline">
      <title>History</title>
      <desc>Historical timeline</desc>
    </cell>
  </grid>
</page>

Cell sizes: full (100%), half (50%), third (33%), quarter (25%)
Cell types: text, diagram, stats, fact, list, timeline, comparison, code, quote, gallery

Rules:
- Create 6-10 cells with varied sizes for visual interest
- Use smaller cells (third, quarter) for facts and stats
- Use full/half for main content and diagrams
- Keep titles short (2-4 words)
- Keep descriptions brief (1 sentence)
- Infobox should have 4-6 key facts
- Output ONLY the XML"""

# System prompt for CONTENT generator - compact, minimal Wikipedia-style
CONTENT_SYSTEM_PROMPT = """You generate compact, minimal HTML content blocks for a Wikipedia-style knowledge page.

OUTPUT RULES:
1. Start with <div class="kp-cell"> - no markdown, no backticks
2. End with </div>
3. Include <style> tag with all CSS inside the div
4. Keep content COMPACT and MINIMAL
5. Use class names starting with "kp-"

CSS Variables:
--kp-bg: var(--background);
--kp-card: var(--card);
--kp-border: var(--border);
--kp-text: var(--foreground);
--kp-muted: var(--muted-foreground);
--kp-primary: var(--primary);

Design principles:
- Clean, minimal, professional
- Small font sizes (12-14px for body)
- Tight spacing (8-16px padding)
- Subtle borders and shadows
- No excessive decoration
- Wikipedia-inspired but modern

For different types:
- text: Clean paragraphs, 13px font, tight line-height
- stats: Big numbers with small labels, grid layout
- fact: Icon + short text, compact card
- diagram: Simple SVG or CSS visuals
- list: Compact bullet points
- timeline: Horizontal or vertical timeline
- comparison: Side-by-side minimal cards
- quote: Subtle blockquote styling

Example for a "fact" type:
<div class="kp-cell">
<style>
.kp-fact { padding: 12px; }
.kp-fact-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--kp-muted); margin-bottom: 4px; }
.kp-fact-value { font-size: 14px; color: var(--kp-text); font-weight: 500; }
</style>
<div class="kp-fact">
  <div class="kp-fact-title">Key Insight</div>
  <div class="kp-fact-value">The main fact goes here in a concise way.</div>
</div>
</div>

Keep everything tight and minimal!"""


@router.get("/explore/{topic}", summary="Stream knowledge page layout", operation_id="explore_topic")
async def explore_topic(topic: str):
    """
    Planner endpoint - streams the layout XML structure for a knowledge page.
    """
    logger.info(f"📋 Planning layout for topic: {topic}")

    messages = [
        {"role": "system", "content": PLANNER_SYSTEM_PROMPT},
        {"role": "user", "content": f"Create a Wikipedia-style knowledge page layout for: {topic}"}
    ]

    try:
        llm_response = await llm.make_llm_api_call(
            messages=messages,
            model_name="groq/moonshotai/kimi-k2-instruct",
            temperature=0.7,
            max_tokens=2000,
            stream=True,
        )

        async def stream_generator():
            try:
                async for chunk in llm_response:
                    if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                        content = chunk.choices[0].delta.content
                        yield f"data: {json.dumps({'type': 'content', 'content': content})}\n\n"
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
            except Exception as e:
                logger.error(f"Stream error: {e}")
                yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
            }
        )

    except Exception as e:
        logger.error(f"Error in explore_topic: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/explore/content/{cell_id}", summary="Stream cell content", operation_id="generate_cell_content")
async def generate_cell_content(
    cell_id: str,
    title: str,
    description: str,
    type: str = "text",
    size: str = "full",
    topic: str = ""
):
    """
    Content endpoint - streams HTML+CSS for a specific grid cell.
    """
    logger.info(f"🎨 Generating {type} content for cell {cell_id}: {title}")

    user_prompt = f"""Create compact HTML content for a "{type}" cell in a Wikipedia-style knowledge page:

Topic: {topic}
Cell Title: {title}
Description: {description}
Size: {size}

Requirements:
- Keep it COMPACT and MINIMAL
- Cell is {size} width, so adjust content density accordingly
- Use small fonts (12-14px), tight spacing
- NO excessive padding or margins
- Start with <div class="kp-cell">, include <style>, end with </div>"""

    messages = [
        {"role": "system", "content": CONTENT_SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt}
    ]

    try:
        llm_response = await llm.make_llm_api_call(
            messages=messages,
            model_name="groq/moonshotai/kimi-k2-instruct",
            temperature=0.7,
            max_tokens=2500,
            stream=True,
        )

        async def stream_generator():
            try:
                async for chunk in llm_response:
                    if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                        content = chunk.choices[0].delta.content
                        yield f"data: {json.dumps({'type': 'content', 'content': content, 'cell_id': cell_id})}\n\n"
                yield f"data: {json.dumps({'type': 'done', 'cell_id': cell_id})}\n\n"
            except Exception as e:
                logger.error(f"Stream error for cell {cell_id}: {e}")
                yield f"data: {json.dumps({'type': 'error', 'message': str(e), 'cell_id': cell_id})}\n\n"

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
            }
        )

    except Exception as e:
        logger.error(f"Error generating content for cell {cell_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
