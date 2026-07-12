---
name: gstack
description: Opinionated full-stack technology stack recommendations and scaffolding. Use when starting new projects, choosing tech stacks, setting up monorepos, or configuring development tooling. Triggers when user asks "what stack should I use", "help me start a new project", "scaffold this app", "set up my project structure", or is choosing between frameworks. Provides battle-tested stack recommendations for different project types.
---

# GStack: Full-Stack Project Scaffolding

Inspired by: https://github.com/garrytan/gstack

## Stack Recommendations by Project Type

### 🚀 Modern SaaS App
```
Frontend:  Next.js 14+ (App Router)
Styling:   Tailwind CSS + shadcn/ui
Auth:      NextAuth.js / Clerk
Database:  PostgreSQL (Neon/Supabase)
ORM:       Prisma / Drizzle
API:       Next.js Route Handlers / tRPC
Payments:  Stripe
Deploy:    Vercel
Testing:   Vitest + Playwright
```

### 📱 Mobile App
```
Framework: Expo (React Native)
Navigation: Expo Router
Styling:   NativeWind (Tailwind for RN)
State:     Zustand / Jotai
Backend:   Supabase / Firebase
Auth:      Clerk / Supabase Auth
Deploy:    EAS Build
```

### 🛠️ Developer Tool / CLI
```
Runtime:   Node.js / Bun
CLI:       Commander.js / Yargs / oclif
Output:    Chalk + ora + inquirer
Config:    cosmiconfig
Build:     tsup
Publish:   npm
Testing:   Vitest
```

### 🤖 AI Application
```
Frontend:  Next.js
AI SDK:    Vercel AI SDK
LLM:       Anthropic Claude API
Vector DB: Pinecone / pgvector
Cache:     Redis (Upstash)
Auth:      NextAuth.js
Deploy:    Vercel
```

### 📊 Data Dashboard
```
Frontend:  Next.js or Remix
Charts:    Recharts / Tremor / Observable Plot
Data:      DuckDB / Prisma
Tables:    TanStack Table
UI:        shadcn/ui
Deploy:    Vercel / Railway
```

### 🎮 Real-time App (Chat, Collab)
```
Frontend:  Next.js
Real-time: Liveblocks / Ably / Supabase Realtime
State:     Zustand + Immer
Auth:      Clerk
DB:        Supabase (PostgreSQL)
Deploy:    Vercel + Railway
```

## Project Scaffolding Checklist

### New Project Setup
```bash
# Next.js
npx create-next-app@latest my-app \
  --typescript --tailwind --eslint --app --src-dir

# Expo
npx create-expo-app my-app --template

# Install common deps
npm install prisma @prisma/client
npm install next-auth
npm install @t3-oss/env-nextjs zod  # Type-safe env vars
```

### Essential Configuration Files

**tsconfig.json**: Strict mode, path aliases
```json
{
  "compilerOptions": {
    "strict": true,
    "paths": { "@/*": ["./src/*"] }
  }
}
```

**Folder Structure (Next.js App Router)**:
```
src/
├── app/                 # Routes
│   ├── (auth)/         # Auth routes group
│   ├── (dashboard)/    # App routes group
│   └── api/            # API routes
├── components/
│   ├── ui/             # shadcn components
│   └── [feature]/      # Feature components
├── lib/
│   ├── db.ts           # DB client
│   ├── auth.ts         # Auth config
│   └── utils.ts        # Utilities
├── hooks/              # Custom hooks
├── types/              # TypeScript types
└── server/             # Server-only code
```

### Environment Variables Pattern
```bash
# .env.local
DATABASE_URL=
NEXTAUTH_SECRET=
NEXTAUTH_URL=http://localhost:3000

# Use @t3-oss/env-nextjs for type-safe env
```

## Code Quality Setup
```bash
# Linting + Formatting
npm install -D eslint prettier eslint-config-prettier
npm install -D @typescript-eslint/eslint-plugin

# Git hooks
npm install -D husky lint-staged
npx husky init

# Commit linting
npm install -D commitlint @commitlint/config-conventional
```

Stack choices date quickly — verify current major versions before scaffolding. Use **super-personas:architect** for architecture decisions and **paul-loop** (same plugin) to scaffold large projects systematically.
