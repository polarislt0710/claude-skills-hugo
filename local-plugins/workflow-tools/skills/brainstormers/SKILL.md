---
name: brainstormers
description: Structured brainstorming and ideation using proven methods — Big Mind Mapping, Reverse Brainstorming, Role Storming, SCAMPER, Six Thinking Hats, Starbursting. Use when the user wants to generate, expand, challenge, compare, or organize ideas for products, features, content, campaigns, plans, or risks. Triggers on "brainstorm", "give me ideas", "help me think through", "SCAMPER", "six thinking hats", "how could this fail", "幫我諗下", "諗 ideas", or any open-ended ideation request.
---

# Brainstormers

Use this skill for structured ideation instead of free-form "here are 10 ideas" dumps.

It is most useful for:
- product and feature ideation
- startup or side-project concepts
- content, campaign, or positioning ideas
- project planning and question discovery
- debugging or risk analysis from unusual angles
- expanding or improving an existing concept

Adapted from `Azzedde/brainstormers` (https://github.com/Azzedde/brainstormers).

## Workflow

1. Identify the user's goal:
   - explore a wide space
   - improve an existing idea
   - find risks or failure modes
   - examine perspectives
   - make a decision
   - generate planning questions
2. If the user already chose a brainstorming method, use it.
3. Otherwise, select the method that best fits the goal and say which one you chose.
4. Ask at most one concise clarifying question only if the target is too vague to be useful.
5. Then produce output in this shape:
   - brief framing of the challenge
   - structured idea generation using the chosen method
   - shortlist of strongest directions
   - concrete next steps

## Method Selection

- **Big Mind Mapping**: use for broad exploration, early discovery, or when the user wants many branches of ideas.
- **Reverse Brainstorming**: use for risk discovery, debugging, resilience, or "how could this fail?" questions.
- **Role Storming**: use when stakeholder, persona, or team perspectives matter.
- **SCAMPER**: use when improving or remixing an existing product, process, or concept.
- **Six Thinking Hats**: use when the user needs balanced analysis or a decision with tradeoffs.
- **Starbursting**: use when the user needs planning questions more than answers.

For method-specific guidance, read [references/methods.md](references/methods.md).

## Output Style

- Prefer structure over volume.
- Make assumptions explicit when you proceed without clarification.
- Keep divergence and convergence separate: first generate, then narrow.
- Avoid generic filler ideas. Bias toward distinct angles.
- When useful, group ideas into themes rather than flat lists.
- End with a recommendation for what to test, prototype, or decide next.

## Default Response Pattern

Use a compact format like:

```markdown
## Framing

## Method

## Ideas

## Best Bets

## Next Steps
```

If the user asks for multiple methods, run them sequentially and label each section clearly.

## When Not to Use

- simple factual questions
- tasks that need direct implementation instead of ideation
- cases where the user explicitly wants unstructured free association
