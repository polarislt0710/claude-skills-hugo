---
name: typography
description: Apply 5 professional typography rules - scale, weight, measure (line length), paragraph spacing, contrast - with WCAG AA/AAA compliance. Use when reviewing or designing UI text, building a type system, picking font sizes, or fixing readability issues. Triggers on "improve typography", "fix the type", "what font sizes", "type scale", "text contrast", "line spacing", "is this readable".
---

# Typography Rules

Five non-negotiable rules for professional UI typography.

## 1. Type scale — establish hierarchy

- Max 3–4 font sizes per page
- Ratio: **1.25 (minor third)** or **1.333 (perfect fourth)**
- Default: 16 px body, 24 px h3, 32 px h2, 48 px h1
- Line height: **1.5 for body**, **1.2 for headings**

## 2. Weight discipline

- Use **only 2–3 weights**: Regular (400), Medium (500), Bold (700)
- Don't use weight for decoration — use it for hierarchy
- Light weights (<300) only for large display text (≥48 px)

## 3. Measure (line length)

- **Optimal: 60–80 characters per line**
- Apply `max-width: 65ch` to body text containers
- Wider for tables/code, narrower for captions

## 4. Paragraph & text spacing

- Paragraph spacing: **1.5× line height**
- Letter spacing: 0 for body, +0.05em for ALL CAPS / small text
- Word spacing: don't modify, browser default is correct

## 5. Contrast (WCAG)

- **Body text: 4.5:1 minimum** (WCAG AA)
- Large text (≥18 px): 3:1 minimum
- UI components & graphical elements: 3:1 minimum
- Aim for **WCAG AAA (7:1) for body text** — accessibility AND aesthetic win

## Quick audit

When reviewing typography, ask:
1. Are there ≤4 font sizes total?
2. Are weights used for hierarchy, not decoration?
3. Is body text 60–80ch wide?
4. Is line height 1.5 for body, 1.2 for headings?
5. Does text contrast pass WCAG AA at minimum?
