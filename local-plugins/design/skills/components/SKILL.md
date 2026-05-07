---
name: components
description: Apply 5 professional component-design rules covering buttons, forms, cards, icons, and motion. Use when designing/reviewing UI components, building a component library, or auditing interaction states. Triggers on "design this button", "form layout", "card component", "icon usage", "add motion", "animation timing", "component states", "design system component".
---

# Component Rules

Five rules for the components that make up most UIs.

## 1. Button

```
VARIANTS:    Primary (filled, brand), Secondary (outlined),
             Ghost (text-only), Destructive (red)
SIZES:       sm (32 px h), md (40 px h), lg (48 px h)
STATES:      default, hover, active/pressed, focus, disabled, loading
PADDING:     vertical : horizontal = 1 : 3 ratio   e.g. 12px × 36px
```

- One primary button per view
- Disabled buttons should explain WHY (tooltip / inline help) — not just be greyed out

## 2. Form

- **Label ABOVE input** (not placeholder-only — placeholders disappear on type)
- **Input height**: 40–48 px (touch-friendly)
- **Error state**: red border + error message **below** the input (not as tooltip)
- **Validate on blur**, not on every keystroke (avoid premature errors)
- Required field indicator: `*` AFTER the label
- Group related fields with proximity (not just borders)

## 3. Card

```
PADDING:        16 px or 24 px (consistent across system)
BORDER RADIUS:  8–12 px for cards
SHADOW:         subtle — 0 2px 8px rgba(0,0,0,0.08)
HOVER STATE:    only if interactive — lift shadow + cursor pointer
```

- Don't combine border AND shadow (pick one signal for elevation)
- Card title should be the most prominent text inside

## 4. Icon

- **Size = match text line-height** (16 px icon next to 16 px text)
- **Optical alignment** (eyeball it) — pure mathematical centering looks off for asymmetric icons
- **Pair icons with text labels** when meaning isn't universal (gear = settings is OK alone, but most aren't)
- **One icon set** per product (don't mix Heroicons + Material + Lucide)

## 5. Motion

```
DURATION:    micro-interactions  : 150–300 ms
             layout transitions  : 300–500 ms
             page transitions    : 400–600 ms
EASING:      ease-out for elements ENTERING
             ease-in for elements EXITING
             ease-in-out for elements MOVING (already on screen)
```

- **Purpose**: motion guides attention, not decoration. Ask "what does this animation help the user understand?"
- **Respect `prefers-reduced-motion`** — disable non-essential animation when user has set OS-level reduce motion
- **Don't animate the same property twice** in a transition (e.g. fade + slide is fine; fade + slide + scale is too much)
