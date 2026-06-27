---
name: text-animations
description: Typography and text animation patterns for Remotion.
metadata:
  tags: typography, text, typewriter, highlighter ken
---

## Text animations

Based on `useCurrentFrame()`, reduce the string character by character to create a typewriter effect.

## Typewriter Effect

Always use string slicing for typewriter effects. Never use per-character opacity.

## Word Highlighting

Animate word highlights by interpolating the highlight width or scale behind the text, like a highlighter pen moving across the word.
