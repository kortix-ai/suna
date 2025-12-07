from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from core.services import llm
from core.utils.logger import logger
import json

router = APIRouter(tags=["Kortixpedia"])

# System prompt for the PLANNER - Wikipedia-style with in-depth sections
PLANNER_SYSTEM_PROMPT = """You are a knowledge page planner creating Wikipedia-style educational pages with DEPTH and DETAIL.

OUTPUT ONLY VALID XML. No explanations, no markdown, just pure XML starting with <page>.

Structure a comprehensive page like Wikipedia with:
1. Quick facts sidebar (infobox)
2. Introduction
3. Multiple in-depth sections with subsections
4. Mix of content types (text, diagrams, timelines, stats, comparisons)

XML Structure:
<page>
  <title>Page Title</title>
  <subtitle>Brief one-line description</subtitle>
  
  <infobox>
    <item label="Category">Value</item>
    <item label="Type">Value</item>
    <item label="Key Stat">Value</item>
    <item label="Related">Value</item>
  </infobox>
  
  <intro>A comprehensive 2-3 paragraph introduction covering the topic overview, its importance, and key aspects.</intro>
  
  <toc>
    <entry id="1">First Major Section</entry>
    <entry id="2">Second Major Section</entry>
    <entry id="3">Third Major Section</entry>
  </toc>
  
  <content>
    <!-- Major section - full width, in-depth -->
    <section id="1" type="text">
      <title>First Major Section Title</title>
      <desc>Detailed explanation of this section covering multiple aspects. Include historical context, key concepts, and current state. This should be comprehensive and educational.</desc>
    </section>
    
    <!-- Stats row - multiple small cards -->
    <row>
      <card id="2" size="quarter" type="stat">
        <title>Key Number</title>
        <desc>Important statistic with context</desc>
      </card>
      <card id="3" size="quarter" type="stat">
        <title>Another Stat</title>
        <desc>Another important number</desc>
      </card>
      <card id="4" size="quarter" type="fact">
        <title>Quick Fact</title>
        <desc>Interesting tidbit</desc>
      </card>
      <card id="5" size="quarter" type="fact">
        <title>Did You Know</title>
        <desc>Engaging fact</desc>
      </card>
    </row>
    
    <!-- Another major section with visual -->
    <section id="6" type="diagram">
      <title>How It Works</title>
      <desc>Visual explanation of the process or system. Include step-by-step breakdown, key components, and relationships between elements.</desc>
    </section>
    
    <!-- Two-column comparison or related topics -->
    <row>
      <card id="7" size="half" type="text">
        <title>Sub-topic A</title>
        <desc>Detailed explanation of this aspect</desc>
      </card>
      <card id="8" size="half" type="text">
        <title>Sub-topic B</title>
        <desc>Detailed explanation of this aspect</desc>
      </card>
    </row>
    
    <!-- Timeline section -->
    <section id="9" type="timeline">
      <title>History and Development</title>
      <desc>Chronological overview of key events, milestones, and developments. Include dates, significant moments, and how things evolved over time.</desc>
    </section>
    
    <!-- Impact or applications section -->
    <section id="10" type="list">
      <title>Impacts and Effects</title>
      <desc>Comprehensive list of consequences, applications, or effects. Cover multiple categories and provide context for each.</desc>
    </section>
    
    <!-- Comparison section -->
    <section id="11" type="comparison">
      <title>Comparing Approaches</title>
      <desc>Side-by-side comparison of different methods, viewpoints, or options. Highlight pros, cons, and key differences.</desc>
    </section>
  </content>
</page>

Content Guidelines:
- Create 8-12 content pieces total
- Mix sections (full-width, in-depth) with cards (grid, quick info)
- Sections should have rich, detailed descriptions (3-5 sentences)
- Cards should be concise but informative
- Use varied types: text, diagram, timeline, stats, comparison, list, quote
- Follow Wikipedia's depth - cover history, causes, effects, solutions
- Make it educational and comprehensive

Card sizes: quarter (25%), third (33%), half (50%)
Section types: text, diagram, timeline, comparison, list, stats, quote, gallery

OUTPUT ONLY THE XML."""

# System prompt for MAJOR SECTION content - rich, in-depth HTML
SECTION_CONTENT_PROMPT = """You generate rich, in-depth HTML content for Wikipedia-style knowledge sections.

OUTPUT RULES:
1. Start with <div class="kp-section"> - NO markdown, NO backticks
2. Include <style> tag with all CSS inside
3. End with </div>
4. Create COMPREHENSIVE content with multiple paragraphs, subsections, and visual elements

CSS Variables:
--kp-bg: var(--background);
--kp-card: var(--card);
--kp-border: var(--border);
--kp-text: var(--foreground);
--kp-muted: var(--muted-foreground);
--kp-primary: var(--primary);

Design principles:
- Wikipedia-level depth and quality
- Clear typography hierarchy (h2 for section, h3 for subsections)
- 15-16px body text, proper line-height (1.7)
- Use subsections, bullet points, and highlights
- Include visual elements based on type

For different types create RICH content:
- text: Multiple paragraphs with subsection headings (h3), key terms highlighted, comprehensive coverage
- diagram: SVG or CSS visuals with labels, explanations, and step-by-step breakdowns
- timeline: Vertical or horizontal timeline with dates, events, descriptions, and visual markers
- comparison: Side-by-side cards with detailed pros/cons, features, and analysis
- list: Categorized lists with icons, descriptions, and supporting details
- stats: Large numbers with context, trends, comparisons, and visualizations
- quote: Styled quotes with attribution and context

Example for "text" type section:
<div class="kp-section">
<style>
.kp-section { padding: 1.5rem; }
.kp-title { font-size: 1.5rem; font-weight: 600; color: var(--kp-text); margin-bottom: 1rem; }
.kp-subtitle { font-size: 1.1rem; font-weight: 600; color: var(--kp-text); margin: 1.5rem 0 0.75rem; }
.kp-para { font-size: 15px; line-height: 1.7; color: var(--kp-muted); margin-bottom: 1rem; }
.kp-highlight { background: var(--kp-primary); color: white; padding: 0.1rem 0.3rem; border-radius: 3px; font-weight: 500; }
.kp-list { margin: 1rem 0; padding-left: 1.5rem; }
.kp-list li { margin-bottom: 0.5rem; color: var(--kp-muted); }
</style>
<h2 class="kp-title">Section Title</h2>
<p class="kp-para">Opening paragraph with comprehensive introduction to the topic. Include <span class="kp-highlight">key terms</span> and important context.</p>
<h3 class="kp-subtitle">First Subsection</h3>
<p class="kp-para">Detailed content for this subsection...</p>
<h3 class="kp-subtitle">Second Subsection</h3>
<p class="kp-para">More detailed content...</p>
<ul class="kp-list">
  <li><strong>Key point:</strong> Explanation of the point</li>
  <li><strong>Another point:</strong> More details</li>
</ul>
</div>

Make content COMPREHENSIVE and EDUCATIONAL!"""

# System prompt for CARD content - compact but informative
CARD_CONTENT_PROMPT = """You generate compact HTML content blocks for info cards in a knowledge page grid.

OUTPUT RULES:
1. Start with <div class="kp-card"> - NO markdown, NO backticks
2. Include <style> tag with CSS
3. End with </div>
4. Keep it COMPACT but INFORMATIVE

CSS Variables:
--kp-bg: var(--background);
--kp-card: var(--card);
--kp-border: var(--border);
--kp-text: var(--foreground);
--kp-muted: var(--muted-foreground);
--kp-primary: var(--primary);

For different types:
- stat: Big number (2rem+), label, trend indicator or comparison
- fact: Icon/emoji + concise text, interesting tidbit
- text: 2-3 short paragraphs with key info
- list: 4-6 bullet points with brief descriptions
- quote: Styled blockquote with attribution

Keep cards focused and scannable - they complement the main sections."""


@router.get("/explore/{topic}", summary="Stream knowledge page layout", operation_id="explore_topic")
async def explore_topic(topic: str):
    """Planner endpoint - streams the layout XML structure."""
    logger.info(f"📋 Planning layout for topic: {topic}")

    messages = [
        {"role": "system", "content": PLANNER_SYSTEM_PROMPT},
        {"role": "user", "content": f"Create a comprehensive Wikipedia-style knowledge page layout for: {topic}"}
    ]

    try:
        llm_response = await llm.make_llm_api_call(
            messages=messages,
            model_name="groq/moonshotai/kimi-k2-instruct",
            temperature=0.7,
            max_tokens=3000,
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
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*"}
        )
    except Exception as e:
        logger.error(f"Error in explore_topic: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/explore/content/{content_id}", summary="Stream content", operation_id="generate_content")
async def generate_content(
    content_id: str,
    title: str,
    description: str,
    type: str = "text",
    size: str = "full",
    is_section: str = "true",
    topic: str = ""
):
    """Content endpoint - streams HTML for sections or cards."""
    is_major_section = is_section.lower() == "true"
    logger.info(f"🎨 Generating {'section' if is_major_section else 'card'} {content_id}: {title}")

    # Choose appropriate prompt based on content type
    system_prompt = SECTION_CONTENT_PROMPT if is_major_section else CARD_CONTENT_PROMPT

    user_prompt = f"""Create {'comprehensive, in-depth' if is_major_section else 'compact, informative'} HTML content:

Topic: {topic}
Title: {title}
Description: {description}
Type: {type}
{'This is a MAJOR SECTION - make it detailed with subsections, multiple paragraphs, and rich content.' if is_major_section else 'This is a CARD - keep it compact but informative.'}

Generate {'rich, educational content with depth' if is_major_section else 'focused, scannable content'}.
Start with <div class="kp-{'section' if is_major_section else 'card'}">, include <style>, end with </div>."""

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt}
    ]

    try:
        llm_response = await llm.make_llm_api_call(
            messages=messages,
            model_name="groq/moonshotai/kimi-k2-instruct",
            temperature=0.7,
            max_tokens=4000 if is_major_section else 2000,
            stream=True,
        )

        async def stream_generator():
            try:
                async for chunk in llm_response:
                    if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                        content = chunk.choices[0].delta.content
                        yield f"data: {json.dumps({'type': 'content', 'content': content, 'content_id': content_id})}\n\n"
                yield f"data: {json.dumps({'type': 'done', 'content_id': content_id})}\n\n"
            except Exception as e:
                logger.error(f"Stream error for {content_id}: {e}")
                yield f"data: {json.dumps({'type': 'error', 'message': str(e), 'content_id': content_id})}\n\n"

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*"}
        )
    except Exception as e:
        logger.error(f"Error generating content {content_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
