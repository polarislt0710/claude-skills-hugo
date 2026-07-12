---
name: research-last30days
description: Systematic research methodology focused on recent developments (last 30 days). Use for competitive research, technology trend analysis, market research, news synthesis, and any investigation requiring current, up-to-date information. Triggers when user wants to "research recent X", "what's new in Y", "catch me up on Z", "what happened with X lately", or needs a structured research report on any evolving topic. Uses web search with a recency bias and synthesizes findings into actionable insights.
---

# Research: Last 30 Days Skill

Inspired by: https://github.com/mvanhorn/last30days-skill

## Research Methodology

### Phase 1: Scope Definition
Before searching, clarify:
1. **Topic**: What exactly are we researching?
2. **Angle**: Technology / Business / Academic / Community?
3. **Depth**: Quick scan (5 min) / Standard (15 min) / Deep dive (30 min+)?
4. **Output**: Brief summary / Full report / Bullet points?

### Phase 2: Search Strategy
Use these search patterns for recency-biased results (substitute the current month and year):

```
Core query: "[topic] [year]"
News: "[topic] news [current month] [year]"
Announcements: "[topic] announced released launched [year]"
Trends: "[topic] trends [year]"
Community: "[topic] reddit discussion [year]"
Academic: "[topic] research paper [year]"
```

**Search layers** (go deeper if needed):
1. Direct queries → Official sources
2. News aggregators → Multiple perspectives
3. Community discussions → Practitioner insights
4. Academic/technical → Deep expertise

### Phase 3: Source Evaluation

Rate each source:
- ⭐⭐⭐ Primary source (official blog, paper, release notes)
- ⭐⭐ Quality secondary (tech press, established journalists)
- ⭐ Community/opinion (Reddit, Twitter, forums)

Discard: SEO content farms, undated articles, speculation without basis

### Phase 4: Synthesis Framework

Structure findings as:

```
## Research Report: [Topic]
Period: Last 30 days (as of [date])

### TL;DR (3 sentences max)

### Key Developments
1. [Most significant finding] — [Source] [Date]
2. [Second finding]
3. [Third finding]

### Trend Analysis
- Direction: [improving / declining / stable / volatile]
- Key drivers: [what's causing the trend]
- Signals to watch: [leading indicators]

### Implications
- For [user's context]: [actionable insight]
- Opportunities: [what this enables]
- Risks: [what to watch out for]

### Sources
- [Source 1] — [date] — [credibility rating]
```

## Research Templates by Type

### Technology Research
Focus on: releases, benchmarks, adoption numbers, community sentiment, competitor moves

### Market Research
Focus on: funding rounds, acquisitions, product launches, user growth, pricing changes

### Academic/Science
Focus on: pre-prints, peer-reviewed publications, researcher discussions, conference talks

### Competitive Intelligence
Focus on: feature releases, pricing changes, customer reviews, team changes, partnerships

## Quality Checks
Before finalizing:
- [ ] All key claims have dated sources?
- [ ] No information older than 30 days presented as "recent"?
- [ ] Both positive AND negative signals included?
- [ ] Actionable insights provided, not just facts?
- [ ] Uncertainty acknowledged where evidence is weak?

Feed findings into the **marketing** plugin for trend-based content, and use **data-tools:duckdb-data** for quantitative analysis of gathered data.
