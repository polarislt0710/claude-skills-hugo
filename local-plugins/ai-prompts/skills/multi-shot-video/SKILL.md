---
name: multi-shot-video
description: Build a director-grade timestamped multi-shot sequence for AI video tools (Veo 3.1 timestamp prompting, Kling scene planning, Runway multi-shot, or as a shot list to feed any tool sequentially). Use when the user wants a STORY across shots, not a single moment. Triggers when user says "multi-shot", "scene breakdown", "shot list", "storyboard", "timestamp prompting", "first and last frame", or describes a narrative arc with multiple beats.
---

# Multi-Shot Video Prompt Builder

Build a complete timestamped video sequence — multiple shots, consistent characters, directed pacing — for AI video tools that support timestamp / scene / multi-shot input, OR as a shot list a human/AI generates one clip at a time.

## When to use this (vs single-shot)
- Story has multiple beats: establish → inciting moment → climax → release
- Different shot types needed: wide → medium → close-up
- Character must remain consistent across shots
- Audio cues span the timeline (music swells, dialogue, SFX)

## Core structure

Output FOUR sections:

### 1. Scene Header
- **Setting**: location, time of day, weather, season
- **Characters**: physical description (for consistency / "ingredients" reference across shots)
- **Tone**: cinematic register (gritty / whimsical / corporate / dreamlike)
- **Target duration**: total seconds + platform target

### 2. Shot Sequence (timestamped)
```
[00:00–00:02] Shot description. Camera: [type + move]. Action: [physical specifics]. Audio: [SFX / ambient / dialogue].
[00:02–00:05] Shot description. Camera: …. Action: …. Audio: ….
[00:05–00:08] Shot description. Camera: …. Action: …. Audio: ….
```
- Vary shot types: establish → medium → close → wide reveal etc.
- Mark the **HERO SHOT** (most visually impactful moment) with `★`

### 3. Audio Map
- Music cue points (00:02 build, 00:05 hit, 00:07 release)
- Dialogue lines (with timestamp + speaker)
- SFX moments (footstep at 00:01, glass breaks at 00:04)
- Ambient bed throughout

### 4. Director's Notes
- Generation order: which shot to render FIRST (the "ingredient" / character reference shot)
- Dependency: shots that must reuse characters → render those after the ingredient is locked
- Iteration tips: which shot is highest-risk, where to spend re-rolls

## Principles

1. **One distinct shot per timestamp block** — don't pack 3 actions in 2 seconds
2. **Vary shot types** — sequences feel flat if all shots are medium
3. **Plan audio across the timeline** — silence is also a choice
4. **Identify the hero shot** — the model can iterate on it more times
5. **Use ingredients language** — "the woman from shot 1" / "same red coat" — for character continuity

## Worked example skeleton (skip in output if user gave specific brief)

```
SCENE HEADER
- Setting: Tokyo backstreet, rainy night, neon reflections
- Character: 30s woman in vintage red trench, wet hair plastered, carrying a black umbrella, weary expression
- Tone: noir / contemplative / Wong Kar-wai
- Total duration: 12s (3 shots × 4s, target Veo 3.1)

SHOT SEQUENCE
[00:00–00:04]  Wide establishing. Camera: locked tripod, slight tilt down.
               Action: she walks into frame from left, pauses under a flickering izakaya sign.
               Audio: rain bed, distant taxi horn, wet footsteps.

[00:04–00:08] ★ Medium hero shot. Camera: slow dolly-in to medium close-up.
               Action: she lowers the umbrella, looks up at the sign, exhales visibly.
               Audio: sign electrical buzz, breath, distant traffic, a koto note enters.

[00:08–00:12]  Close-up reverse. Camera: handheld, soft tracking.
               Action: rain droplet runs down her cheek, eyes refocus toward camera.
               Audio: rain intensifies, koto sustains, music starts to swell.

AUDIO MAP
- 00:00–00:12: rain ambient bed
- 00:01: taxi horn, far
- 00:03: footstep splash
- 00:06: koto note enters
- 00:10–00:12: koto sustain → music swell beat

DIRECTOR'S NOTES
- Generate shot 2 first (hero, locks character look + wardrobe)
- Use shot 2 last frame as reference for shots 1 and 3
- Shot 3 is highest risk (subtle action) — budget 3–4 re-rolls
```
