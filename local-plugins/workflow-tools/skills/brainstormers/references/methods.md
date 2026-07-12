# Brainstorming Methods — Detailed Guidance

How to run each of the six methods. Every method still follows the skill's core loop: frame → diverge → converge → next steps.

## Big Mind Mapping

**Goal**: maximum breadth before any judgment.

1. Put the challenge in the center as a single phrase.
2. Generate 4-6 first-level branches — distinct *dimensions* of the problem (e.g. users, channels, tech, pricing, risks, adjacent markets).
3. For each branch, generate 3-5 sub-ideas. Push past the obvious: the first two ideas per branch are usually generic — the value starts at idea three.
4. Mark cross-links between branches (idea in branch A that reinforces branch C).
5. Converge: circle the 3-5 nodes with the highest energy/feasibility and restate each as a one-line direction.

**Output**: indented tree (text), then "Best Bets" list.

## Reverse Brainstorming

**Goal**: find risks/failure modes by inverting the question.

1. Invert: "How could we make this fail as hard as possible?" / "How would we guarantee users hate this?"
2. Generate 8-12 sabotage ideas — be genuinely adversarial, include slow/boring failure modes (neglect, drift, misaligned incentives), not just dramatic ones.
3. Flip each sabotage idea back into a prevention or mitigation.
4. Rank the flipped list by (likelihood × damage).

**Output**: two-column table — "Way to fail" → "Defense" — then top 3 risks to address first.

## Role Storming

**Goal**: surface perspectives the requester wouldn't naturally take.

1. Pick 4-6 roles with genuinely conflicting incentives (not 6 flavors of supporter): e.g. power user, first-time user, skeptical buyer, support staff, competitor, regulator.
2. For each role, answer in that voice: What do I want? What annoys me about this? What would make me say yes?
3. Note direct conflicts between roles — these are the real design tensions.
4. Converge on ideas that resolve or consciously trade off those tensions.

**Output**: one short block per role, then a "Tensions" list, then recommendations.

**Tip**: for a deeper multi-round version with live debate, use `swarm-tools:multi-persona-jam` instead.

## SCAMPER

**Goal**: systematically remix an *existing* thing.

Walk all seven operators against the subject; 1-3 ideas each:
- **S**ubstitute — swap a component, audience, material, channel
- **C**ombine — merge with another product/feature/ritual
- **A**dapt — borrow a pattern from another domain
- **M**odify / Magnify / Minify — exaggerate or shrink an attribute
- **P**ut to another use — new user group, new context
- **E**liminate — remove a step, feature, or requirement entirely
- **R**everse / Rearrange — invert the order, flip the business model

**Output**: 7 labelled rows, then the 2-3 remixes worth prototyping.

## Six Thinking Hats

**Goal**: balanced evaluation / decision support.

Run hats in this order, explicitly labelled:
1. ⚪ **White** — facts and data we have; facts we're missing
2. 🔴 **Red** — gut feelings, appetites, fears (no justification needed)
3. ⚫ **Black** — risks, weaknesses, why it might fail
4. 🟡 **Yellow** — benefits, best-case value, why it might work
5. 🟢 **Green** — new alternatives that address the Black-hat points
6. 🔵 **Blue** — process summary: decision, conditions, next step

**Output**: six short sections, ending with a Blue-hat recommendation. Keep Black and Yellow roughly equal in effort — the method dies when one dominates.

## Starbursting

**Goal**: generate *questions*, not answers — best at project kickoff.

1. Draw six points: **Who / What / Where / When / Why / How**.
2. Generate 4-6 questions per point about the idea. No answering yet.
3. Mark each question: ✅ answerable now / 🔍 needs research / 🚧 blocking decision.
4. Converge: list the blocking decisions and the top research tasks.

**Output**: grouped question list with markers, then "answer these first" shortlist.

## Combining methods

Common sequences:
- **New concept**: Big Mind Mapping → Six Thinking Hats on the winner
- **Existing product**: SCAMPER → Reverse Brainstorming on the chosen remix
- **Project kickoff**: Starbursting → assign research → Role Storming on the contentious answers
