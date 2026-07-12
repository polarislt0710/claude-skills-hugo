# Swarm Dashboard — Event Payload Reference

All events POST to `$SWARM_DASHBOARD_URL/events/<event-type>` as JSON (default URL `http://187.127.115.235:3010`, override with the `SWARM_DASHBOARD_URL` env var). Use the bundled `scripts/emit-event.sh` — it handles the URL, timeouts, and never fails the jam.

## Event types & payloads

| Event type | When | Payload |
|---|---|---|
| `swarm-start` | Phase 0, before spawning agents | `{"topic":"<TOPIC>","personas":["P1","P2","P3"]}` |
| `agent-proposal` | Phase 1 (one per persona) AND Phase 4 revisions (overwrites node content) | `{"agent":"<persona>","content":<json-escaped markdown>}` |
| `debate-message` | Phase 2, one per exchange per round | `{"from":"<from>","to":"<to>","content":"【第 <round> 回合 — <label>】\n\n<content>"}` |
| `rebuttal` | Phase 3, one per persona | `{"agent":"<persona>","critic":"全體","content":<json-escaped>}` |
| `synthesis-complete` | Phase 5 (re-emit on mid-jam refresh) | `{"content":<json-escaped synthesis markdown>}` |
| `persona-added` | Mid-jam new persona | `{"agent":"<new persona>","content":<json-escaped position paper>}` |
| `context-update` | Mid-jam rethink | `{"context":"<short summary>","instruction":"rethink with constraint"}` |

## Escaping multi-line content

Use `jq -Rs .` to turn raw markdown into a JSON string:

```bash
CONTENT_JSON=$(printf '%s' "$CONTENT" | jq -Rs .)
bash "<skill-dir>/scripts/emit-event.sh" agent-proposal \
  "{\"agent\": \"校長\", \"content\": $CONTENT_JSON}"
```

Or build the whole payload with jq and pipe it:

```bash
printf '%s' "$CONTENT" | jq -Rs '{agent: "校長", content: .}' \
  | bash "<skill-dir>/scripts/emit-event.sh" agent-proposal -
```

## Pacing

Space POSTs so the dashboard animation is watchable:
- `debate-message`: **0.5-0.8s** sleep between events
- `rebuttal`: **0.4-0.6s** between events
- Other events: no pacing needed

## Fallback (script unavailable)

If `emit-event.sh` can't be located, the raw call is:

```bash
curl -s -m 5 -X POST "${SWARM_DASHBOARD_URL:-http://187.127.115.235:3010}/events/<event-type>" \
  -H "Content-Type: application/json" -d '<payload>' || true
```

A connection failure must never abort the jam — warn once and continue without visualization.
