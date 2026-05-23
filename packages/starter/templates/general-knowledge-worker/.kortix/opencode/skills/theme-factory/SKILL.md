---
name: theme-factory
description: "> Scope: Non-website assets only. This skill applies to slides, docs, reportings, and other non-web artifacts. For website projects, do NOT use this skill — use the website-buil..."
---

# Theme Factory Skill

> **Scope: Non-website assets only.** This skill applies to slides, docs, reportings, and other non-web artifacts. For website projects, do NOT use this skill — use the `website-building` skill instead, which has its own design tokens, typography, and color systems.

This skill provides a curated collection of professional font and color themes, each with carefully selected color palettes and font pairings. Once a theme is chosen, it can be applied to any non-web artifact.

**Design philosophy:** All themes follow the design-foundations principle of **1 accent + neutrals**. Each theme has one dominant accent color — use it sparingly (headings, key data, icons). The remaining palette colors are neutral/muted surface and text tones. See `skills/design-foundations/SKILL.md` for the full color philosophy. If no theme is selected, default to the Nexus palette.

## Purpose

To apply consistent, professional styling to presentation slide decks and other non-web artifacts, use this skill. Each theme includes:
- A cohesive color palette with hex codes
- Complementary font pairings for headers and body text
- A distinct visual identity suitable for different contexts and audiences

## Usage Instructions

To apply styling to a slide deck or other non-web artifact:

1. **Show the theme showcase**: Display the `theme-showcase.pdf` file to allow users to see all available themes visually. Do not make any modifications to it; simply show the file for viewing.
2. **Ask for their choice**: Ask which theme to apply to the deck
3. **Wait for selection**: Get explicit confirmation about the chosen theme
4. **Apply the theme**: Once a theme has been chosen, apply the selected theme's colors and fonts to the deck/artifact. If the user is building a website, redirect them to the `website-building` skill instead

## Themes Available

The following 10 themes are available, each showcased in `theme-showcase.pdf`:

1. **Ocean Depths** - Professional and calming maritime theme
2. **Sunset Boulevard** - Warm and vibrant sunset colors
3. **Forest Canopy** - Natural and grounded earth tones
4. **Modern Minimalist** - Clean and contemporary grayscale
5. **Golden Hour** - Rich and warm autumnal palette
6. **Arctic Frost** - Cool and crisp winter-inspired theme
7. **Desert Rose** - Soft and sophisticated dusty tones
8. **Tech Innovation** - Bold and modern tech aesthetic
9. **Botanical Garden** - Fresh and organic garden colors
10. **Midnight Galaxy** - Dramatic and cosmic deep tones

## Theme Details

Each theme is defined in the `themes/` directory with complete specifications including:
- Cohesive color palette with hex codes
- Complementary font pairings for headers and body text
- Distinct visual identity suitable for different contexts and audiences

## Application Process

After a preferred theme is selected:
1. Read the corresponding theme file from the `themes/` directory
2. Apply the specified colors and fonts consistently throughout the deck
3. Ensure proper contrast and readability
4. Maintain the theme's visual identity across all slides

## Create your Own Theme
To handle cases where none of the existing themes work for an artifact, create a custom theme. Based on provided inputs, generate a new theme similar to the ones above. Give the theme a similar name describing what the font/color combinations represent. Use any basic description provided to choose appropriate colors/fonts. After generating the theme, show it for review and verification. Following that, apply the theme as described above.

**Custom theme requirements:**
- **1 accent + neutrals** — one bold accent color, 1-2 neutral/muted supporting tones, one dark or light base. Do not create palettes with 2+ strong accent colors.
- **WCAG AA contrast** — accent and text colors must pass 4.5:1 on their paired backgrounds. Never use maximum-saturation colors (e.g., `#00ffff`, `#ff0000`) as foreground on light backgrounds.
- **Earn every color** — if a color doesn't help the viewer understand something, make it neutral.