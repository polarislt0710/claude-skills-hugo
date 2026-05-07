---
name: single-shot-video
description: Generate prompts for single-shot AI video tools (Veo, Kling, Runway, Seedance, Hailuo, Sora) where one continuous clip (4-10s) is the output. Use when the user wants ONE moment captured as motion. Triggers when user says "video prompt", "video clip", "Veo prompt", "Kling prompt", or describes a single moment of action / camera movement.
---

# Single-Shot Video Prompt Builder

Build a paste-ready prompt for one continuous AI video clip (typically 4–10 seconds).

## Core formula

```
[Cinematography] + [Subject] + [Action] + [Context] + [Style & Ambiance] + [Audio]
```

Open with shot type + camera move — that's the most powerful lever.

## Principles

1. **Camera move first.** "Slow dolly-in", "tracking shot from left", "aerial drone push" — the model uses this immediately.
2. **Specific physical action.** Not "moves dynamically" — "runs at full sprint, arms pumping, breath visible in cold air".
3. **Lens language.** Shallow depth of field f/1.8, wide-angle, macro, soft focus, anamorphic.
4. **Audio if model supports it.** (Veo 3.1, Kling 2.1) — dialogue in quotes; SFX with [label]; ambient with one descriptor.
5. **Color grade + film aesthetic.** Teal-and-orange, desaturated, high-contrast B&W, vintage film print.
6. **Duration target.** State 4 / 6 / 8 seconds — different platforms favor different lengths.

## Output format

```
[Single clean prompt block]

Suggested duration: __s
Optimized for: __ (if user specified a platform)
```

## Platform reference

| Platform | Best length | Audio | Notes |
|---|---|---|---|
| Veo 3.1 | 4–8s | ✅ Full | Strongest audio. Use ingredients-to-video for character consistency. |
| Kling 2.1 | 5–10s | ✅ Partial | Great character consistency |
| Runway Gen-4 | 5–10s | ❌ | Cleanest motion quality |
| Seedance 2.0 | 4–8s | ❌ | Strong for effects-heavy work |
| Hailuo | 6s | ❌ | Stylized / cinematic |
| Sora | up to 20s | ❌ | Best for longer single shots |

## Worked example

**User**: "A surfer paddling out at dawn"

```
Wide tracking shot from waist-deep water, slowly pushing in. A surfer in a black wetsuit
paddles a longboard through glassy pre-dawn swells, water beading off her arms with each
stroke, eastern sky bleeding pink-orange behind her. Shot on anamorphic 35mm at f/2.8,
shallow depth, salt spray catching the light. Ambient: gentle wave wash, distant gull cry.
Color grade: warm highlights, cool teal shadows, slight film grain. Duration: 6 seconds.

Suggested duration: 6s
Optimized for: Veo 3.1
```
