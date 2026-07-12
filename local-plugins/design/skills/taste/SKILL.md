---
name: taste
description: Aesthetic reference library for building polished, distinctive UI. Maps well-known visual styles (Linear/Vercel minimal, bold editorial, warm human, glassmorphism premium, brutalist) to concrete palette, type, spacing, and motion values. Use when visual output should feel intentional and inspired by high-quality references rather than generic. Triggers when user says "make it look like Linear/Vercel/Stripe", "inspired by X style", "feel premium/minimal/bold/warm", "give this more character", or names any design reference to match.
---

# Taste: Building with Reference

Inspired by: https://github.com/Leonxlnx/taste-skill

## Core Philosophy
Great design borrows. Excellent design synthesizes. Always look at reference, understand WHY it works, then apply the principle — not the pixels.

## Reference Categories

### Minimal & Clean
**References**: Linear.app, Vercel, Stripe Dashboard, Notion
**Characteristics**:
- Generous whitespace (padding 40-80px sections)
- Monochromatic or near-monochromatic palette
- Typography does the heavy lifting
- Subtle borders (1px, #E5E5E5 or similar)
- Icons: thin, line-style
- Motion: subtle, purposeful fades

**When to use**: SaaS products, developer tools, productivity apps

### Bold & Editorial
**References**: The Pudding, Are.na, Basement Studio, Awwwards winners
**Characteristics**:
- Large display typography (80-120px+)
- High contrast (black/white + 1 accent)
- Intentional layout breakouts
- Variable fonts for expressiveness
- Fewer but more meaningful elements

**When to use**: Portfolio sites, creative agencies, editorial content

### Warm & Human
**References**: Notion.ai, Framer, Loom, Linear (new branding)
**Characteristics**:
- Warm neutrals (not pure #FFFFFF, use #FAFAF8)
- Rounded corners (12-16px+)
- Friendly sans-serif typefaces
- Illustrations or 3D elements
- Smooth animations, spring physics

**When to use**: Consumer apps, collaboration tools, lifestyle products

### Glassmorphism & Premium
**References**: Apple (iOS/macOS), Stripe, Figma
**Characteristics**:
- Backdrop blur (8-20px)
- Semi-transparent surfaces
- Gradient borders
- Premium dark mode by default
- Depth through shadows and blur

**When to use**: Marketing sites, premium products, dark-mode-first apps

### Brutalist/Raw
**References**: Bloomberg, early Figma, newspaper sites
**Characteristics**:
- Mono or serif typefaces
- Grid-heavy, rigid structure
- High contrast, minimal decoration
- Text as primary design element

**When to use**: Media sites, technical documentation, unique brand identity

## Reference Analysis Framework
When given a reference to match:
1. **Identify the style** — which category does it fall into?
2. **Extract the palette** — primary, secondary, accent, background
3. **Identify type** — font family, weights, sizes used
4. **Map the spacing** — what's the base unit?
5. **Note the motion** — fast/slow, spring/ease, which elements move
6. **Capture the "feel"** — 3 adjectives that describe the vibe
7. **Apply principles** — recreate the FEEL, not the exact pixels

## Taste Prompts
- "Design in the style of Linear.app"
- "Minimal SaaS dashboard, Vercel-inspired"
- "Make it feel premium, like a design tool"
- "Bold editorial, newspaper meets tech"
- "Warm and friendly, Framer-style"

Pair with the same plugin's **typography / color / layout / components** rules for the technical execution, and **web-motion-design** for the motion reference.
