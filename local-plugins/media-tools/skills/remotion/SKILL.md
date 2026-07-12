---
name: remotion
description: Create programmatic videos using Remotion (React-based video framework) with production-ready patterns. Use for animated explainer videos, data visualizations as video, social media video content, automated video generation, and for reviewing or optimising existing Remotion code. Triggers when user wants to "make a video with code", "animate this as video", "create a Remotion component", "data viz video", asks about Remotion performance or best practices, or wants to automate video creation. Best for developers who prefer code over video editors.
---

# Remotion: Programmatic Video Creation

Sources: https://github.com/remotion-dev/remotion + https://github.com/remotion-dev/skills

## Core Concepts

Remotion lets you create videos using React. Each frame is a React component. Time is just a prop.

### Key Hooks
```tsx
import { useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';

const MyComp = () => {
  const frame = useCurrentFrame();        // Current frame number
  const { fps, durationInFrames, width, height } = useVideoConfig();

  // interpolate: map frame range to value range
  const opacity = interpolate(frame, [0, 30], [0, 1]);

  // spring: physics-based animation
  const scale = spring({ frame, fps, from: 0, to: 1 });

  return <div style={{ opacity, transform: `scale(${scale})` }}>Hello</div>;
};
```

## Common Video Patterns

### Fade In/Out
```tsx
const FadeIn = ({ children, startFrame = 0, duration = 30 }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(
    frame,
    [startFrame, startFrame + duration],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  return <div style={{ opacity }}>{children}</div>;
};
```

### Text Animation (Word by Word)
```tsx
const AnimatedText = ({ text }) => {
  const frame = useCurrentFrame();
  const words = text.split(' ');
  return (
    <div>
      {words.map((word, i) => {
        const delay = i * 5; // 5 frames between each word
        const opacity = interpolate(frame, [delay, delay + 15], [0, 1], {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp'
        });
        return <span key={i} style={{ opacity, display: 'inline-block', marginRight: 8 }}>{word}</span>;
      })}
    </div>
  );
};
```

### Data Visualization Animation
```tsx
const AnimatedBar = ({ value, maxValue, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const width = spring({
    frame: frame - delay,
    fps,
    from: 0,
    to: (value / maxValue) * 100,
    config: { damping: 12 }
  });

  return (
    <div style={{ width: `${width}%`, height: 40, background: 'blue', borderRadius: 4 }} />
  );
};
```

### Sequence Architecture
```tsx
import { AbsoluteFill, Sequence, Series, Audio, staticFile } from 'remotion';

// Sequence: play component starting at a specific frame
<AbsoluteFill>
  <Sequence from={0}   durationInFrames={90}><Intro /></Sequence>
  <Sequence from={90}  durationInFrames={120}><Main /></Sequence>
  <Sequence from={210} durationInFrames={60}><Outro /></Sequence>
</AbsoluteFill>

// Series: play components back-to-back without manual frame math
<Series>
  <Series.Sequence durationInFrames={30}><Intro /></Series.Sequence>
  <Series.Sequence durationInFrames={60}><MainContent /></Series.Sequence>
  <Series.Sequence durationInFrames={30}><Outro /></Series.Sequence>
</Series>

// Audio
<Audio src={staticFile('background.mp3')} volume={0.5} />
```

## Composition Setup
```tsx
import { Composition } from 'remotion';

export const RemotionRoot = () => (
  <>
    <Composition
      id="MyVideo"
      component={MyVideo}
      durationInFrames={150}   // 5 seconds at 30fps
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{ title: "Hello World" }}
    />
  </>
);
```

### Data-Driven Props (Zod Schema)
```tsx
import { z } from 'zod';
export const schema = z.object({
  title: z.string(),
  theme: z.enum(['light', 'dark']),
});
type Props = z.infer<typeof schema>;
// Use Props as component type — fully validated
```

## Common Video Types

### Social Media Short (9:16)
- Width: 1080, Height: 1920
- Duration: 15-60 seconds (450-1800 frames at 30fps)
- Style: Bold text, fast cuts, high contrast

### Explainer Video (16:9)
- Width: 1920, Height: 1080
- Duration: 60-180 seconds
- Style: Clean animations, narration-paced

### Data Visualization
- Use recharts or d3 components
- Animate data in over 1-2 seconds
- Reveal data points sequentially

## Production Rules

### Rule 1: Compositions Must Be Pure
Same frame number must always produce the same output.
```tsx
import { random } from 'remotion';
const r = random('seed'); // deterministic
// NEVER: Math.random(), Date.now(), new Date()
```

### Rule 2: Async with delayRender
```tsx
import { continueRender, delayRender } from 'remotion';
const handle = delayRender('Loading...');
loadAsset().then(() => continueRender(handle));
```

### Rule 3: Always Clamp interpolate()
```tsx
interpolate(frame, [0, 30], [0, 1], {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
});
```

### Rule 4: spring() for Natural Motion
```tsx
const scale = spring({ frame, fps, from: 0, to: 1,
  config: { damping: 12, stiffness: 200 } });
```

### Rule 5: Memoize Heavy Work
```tsx
const data = useMemo(() => computeExpensive(), []);
```

### Rule 6: Preload Assets
```tsx
import { prefetch } from 'remotion';
prefetch('https://cdn.example.com/video.mp4');
// Use staticFile() for assets in /public
```

## Rendering
```bash
npx remotion render src/index.ts MyVideo out/video.mp4
npx remotion render --codec=gif src/index.ts MyVideo out/animation.gif
npx remotion still --frame=30 out/frame.png
npx remotion preview   # test at specific frames
```

## Checklist Before Render
- [ ] All interpolate() clamped
- [ ] No Math.random() / Date.now()
- [ ] Async uses delayRender/continueRender
- [ ] Heavy work in useMemo
- [ ] Assets preloaded / via staticFile()

Use **design:web-motion-design** principles for animation timing, **design** plugin for typography and color, and **data-tools:duckdb-data** to prepare data for data-viz videos.
