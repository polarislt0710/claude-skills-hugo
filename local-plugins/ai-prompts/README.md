# ai-prompts

AI prompt builders split by output mode. Each sub-skill is a focused prompt-engineering recipe for one output format.

| Skill | Output | Tools |
|---|---|---|
| `image` | Single still image | Midjourney, Flux, Nano Banana, Firefly, DALL·E, Stable Diffusion |
| `single-shot-video` | One continuous clip (4–10s) | Veo, Kling, Runway, Seedance, Hailuo, Sora |
| `multi-shot-video` | Timestamped sequence / shot list | Veo 3.1 timestamps, Kling scene planning, director's storyboard |

## Quick decision
- "Make me an image of …" → `image`
- "Make me a video of … (one moment)" → `single-shot-video`
- "Make me a video that does A then B then C" / "scene breakdown" / "storyboard" → `multi-shot-video`

If the request is vague: ask ONE question — "Image or video, and roughly how long?"
