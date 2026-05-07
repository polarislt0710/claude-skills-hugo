---
name: color
description: Apply 5 professional color rules - palette systems, WCAG contrast, semantic meaning, visual hierarchy via color, surface layering. Use when designing/reviewing color usage, building a design system, or auditing accessibility. Triggers on "color palette", "improve contrast", "color system", "dark mode", "is the color choice OK", "color hierarchy", "background colors".
---

# Color Rules

Five rules for systematic, accessible, on-brand color usage.

## 1. Systematic palette

```
PRIMARY     1 brand color × 9 shades (50, 100, 200, ..., 900)
NEUTRAL     gray scale × 9 shades for text and backgrounds
SEMANTIC    success (green), warning (amber), error (red), info (blue)
```

**Max 3 non-neutral hues** in a design (primary + 2 accents at most).

## 2. Contrast (WCAG)

- Check EVERY foreground / background combination
- Use HSL color space for predictable lightness ratios
- **Dark mode**: don't just invert — recalculate contrast in the new context

```
Body text:           4.5:1 minimum (AA)
Large text (≥18px):  3:1 minimum
UI components:       3:1 minimum
Body text aspiration: 7:1 (AAA)
```

## 3. Semantic meaning

- **Don't convey information by color alone** — pair with icon or text label
- Conventions to honor: red = error/danger, green = success, amber/yellow = warning, blue = info
- Avoid using brand color for warnings (mixed signals)

## 4. Color hierarchy

Use color to guide attention:

```
Highest priority:    brand color OR highest contrast in scale
Secondary:           muted / lower-saturation versions
Disabled:            40% opacity OR 3:1 contrast max
```

The single most-saturated color on a page = the primary CTA. If everything's saturated, nothing is.

## 5. Surface layering

For backgrounds and depth:

```
bg-base       page background
bg-subtle     section background
bg-raised     card / panel background
bg-overlay    modal / popover background
```

Keep surface colors within **10–15% lightness steps** — too close = no depth, too far = uncanny.
