---
name: layout
description: Apply 5 professional layout rules - grid systems, spacing scales, alignment, proximity (related-element grouping), visual weight balance. Use when reviewing or designing layout, fixing inconsistent spacing, deciding alignment, or balancing emphasis. Triggers on "fix the layout", "improve spacing", "alignment issue", "grid system", "spacing scale", "visual hierarchy".
---

# Layout Rules

Five rules for visually balanced, mathematically consistent layouts.

## 1. Grid system

- **12-column grid** for complex desktop layouts (allows 2/3/4/6/12 column splits)
- **4-column grid** for mobile
- **Consistent gutters**: 16 px mobile / 24 px tablet / 32 px desktop

## 2. Spacing scale

Pick a base unit (4 px is standard) and **NEVER use arbitrary values**.

```
Spacing tokens:  4, 8, 12, 16, 24, 32, 48, 64, 96 px
```

Apply consistently across:
- Padding (inside elements)
- Margin (between elements)
- Gap (in flex / grid)

If you find yourself wanting `13 px` or `22 px`, you're avoiding a real layout decision.

## 3. Alignment

- **Body text: left-align** (NEVER justify — creates rivers of whitespace)
- **Center**: only for headings and CTAs
- **Right-align**: numbers in tables, currency
- **Grid-align everything** — no element should float between grid lines

## 4. Proximity (group related elements)

Spacing communicates relationships:

```
Related items:        ≤ 8 px apart
Loosely related:      8–16 px apart
Unrelated items:      ≥ 24 px apart
Section breaks:       ≥ 48 px apart
```

If two things should "feel together," reduce space. If two things are different, increase space — no border or color needed.

## 5. Visual weight & emphasis

- **One primary CTA per view** (everything else is secondary)
- Three levers for emphasis: **size + color + position** (use 1–2, not all 3)
- Reading flow: design for **F-pattern** (text-heavy) or **Z-pattern** (sparse, hero-heavy)
- Empty space is a feature, not unused real estate
