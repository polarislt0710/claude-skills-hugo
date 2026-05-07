---
name: image
description: Generate prompts for AI image generation tools (Midjourney, Flux, Stable Diffusion, Firefly, DALL·E, Nano Banana, etc.). Use when the user wants a single still image. Triggers when user says "image prompt", "make me an image", "Midjourney prompt", "generate a picture", or describes a static visual scene without motion.
---

# Image Prompt Builder

Build a paste-ready prompt for any modern image generator.

## Core formula

```
[Subject + Action] + [Location / Context] + [Composition] + [Lighting] + [Style / Aesthetic] + [Camera / Lens] + [Color grading]
```

## Principles

1. **Lead with the subject.** Make the first 6 words count — it carries the most weight in CLIP-based models.
2. **Positive framing.** Describe what IS there, not what isn't. ("a clean kitchen" beats "no clutter")
3. **Lighting is mood.** Specify it explicitly: golden hour, harsh noon, neon glow, single key light, ambient overcast.
4. **Camera + lens controls geometry.** "Shot on 35mm f/1.4" sets depth, framing, character.
5. **Materiality matters.** Specify texture for objects / clothing / environments — "weathered linen", "polished obsidian".
6. **Quoted text + font.** `"Open" in bold sans-serif` for in-image typography.
7. **Style signature at the end.** Film stock (Kodak Portra 400), art movement (mid-century modern), render style (Studio Ghibli, photorealistic, isometric).

## Output format

```
[Single clean prompt block, ready to paste into UI]
```

Optional follow-up:
- 1 sentence on what's iterable (aspect ratio, lighting variant, style swap)
- If the request has multiple plausible interpretations, offer 2 prompt variants

## Worked example

**User**: "I want a moody photo of an old bookstore at night"

```
A solitary owner shelves a leather-bound volume in a narrow second-hand bookshop late at night,
warm tungsten desk lamp casting long shadows across stacked spines, deep window reflection of
empty wet street outside, low-angle medium shot, shot on 50mm f/1.4 with shallow depth of field,
moody chiaroscuro, Kodak Portra 800 film stock, slight grain.
```
