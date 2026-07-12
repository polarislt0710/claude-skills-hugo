---
name: web-motion-design
description: Cinematic web animations and interactive motion design using Framer Motion, GSAP, CSS animations, and modern web APIs. Use when building animated UI components, scroll-driven animations, page transitions, micro-interactions, or any motion that elevates the user experience. Triggers when user asks to "animate this", "add transitions", "make it feel alive", "add scroll animations", "page transitions", or wants to implement motion like top-tier design portfolios. Inspired by Emil Kowalski's motion principles.
---

# Web Motion Design Skill

Inspired by: https://github.com/emilkowalski/skill (Emil Kowalski's motion principles)

## The Motion Principles

### 1. Motion Has Purpose
Every animation should serve a function:
- **Spatial orientation**: Show where elements come from/go to
- **State communication**: Loading, success, error, disabled
- **Hierarchy**: Guide attention to what matters
- **Delight**: Occasional rewards for interaction

### 2. Feel > Look
Motion should feel physical and natural:
- Use spring physics over linear easing
- Objects have weight and momentum
- Quick in, slow out (ease-out for entrances)
- Quick out (ease-in for exits)

### 3. Duration Guidelines
| Type | Duration | Example |
|------|----------|---------|
| Micro | 100-150ms | Button press, checkbox |
| Standard | 200-300ms | Dropdown, tooltip |
| Complex | 300-500ms | Modal, sheet |
| Page | 400-600ms | Route transition |
| Cinematic | 600ms+ | Hero, splash screen |

## Framer Motion Patterns

### Entrance Animations
```jsx
// Fade up (most versatile)
const fadeUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] }
}

// Scale entrance (for modals, cards)
const scaleIn = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  transition: { type: "spring", stiffness: 300, damping: 30 }
}
```

### Stagger Children
```jsx
const container = {
  animate: { transition: { staggerChildren: 0.08 } }
}
const item = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 }
}
// Parent: variants={container}, Children: variants={item}
```

### Shared Layout Animation
```jsx
// Animate between states with layoutId
<motion.div layoutId="pill" className="active-pill" />
// The pill smoothly moves between tabs/items
```

### Scroll-Driven Animations
```jsx
// useScroll + useTransform
const { scrollYProgress } = useScroll()
const opacity = useTransform(scrollYProgress, [0, 0.2], [0, 1])
const y = useTransform(scrollYProgress, [0, 0.2], [60, 0])
```

### Gesture Interactions
```jsx
<motion.div
  whileHover={{ scale: 1.02, y: -2 }}
  whileTap={{ scale: 0.98 }}
  transition={{ type: "spring", stiffness: 400, damping: 25 }}
/>
```

## CSS Animation Patterns

### Modern Easing Curves
```css
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
--ease-in-out-expo: cubic-bezier(0.87, 0, 0.13, 1);
--ease-spring: linear(0, 0.009, 0.035 2.1%, 0.141, 0.281 6.7%, 0.723 12.9%, 0.938 16.7%, 1.017, 1.077, 1.121, 1.149 24.3%, 1.159, 1.163, 1.161, 1.154 29%, 1.129 32.3%, 1.051 39.6%, 1.017 43.1%, 0.991, 0.977 51%, 0.974 53.8%, 0.975 57.1%, 0.997 69.8%, 1.003 73.6%, 1.004 77.3%, 1);
```

### Scroll-Driven CSS
```css
@keyframes fade-in-up {
  from { opacity: 0; transform: translateY(24px); }
  to { opacity: 1; transform: translateY(0); }
}
.animate-on-scroll {
  animation: fade-in-up linear both;
  animation-timeline: view();
  animation-range: entry 0% entry 30%;
}
```

## Accessibility
```jsx
// Always respect reduced motion
const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches

// In Framer Motion
<motion.div
  animate={{ opacity: 1, y: prefersReducedMotion ? 0 : 20 }}
/>
```

Use **components** (same plugin) for component-level motion timing rules, **taste** (same plugin) for motion style references, and **media-tools:remotion** for video/programmatic animation.
