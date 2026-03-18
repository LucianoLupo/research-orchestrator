---
name: research-orchestrator
description: Launch parallel deep research with multiple Claude Code instances and shared memory. Use when the user says "research [topic]", "deep research", "orchestrate research", "parallel research", or wants comprehensive multi-agent investigation of any topic. NOT for quick questions — use for topics that need real depth.
---

# Research Orchestrator (v3 — Shared Memory)

Spawns N parallel Claude Code instances to research a topic from different angles. Agents share memory between rounds: a coordinator identifies gaps after Round 1, then agents fill those gaps in Round 2. Final synthesis + quality scoring.

## When to Use

- User says "research [topic]", "deep research [topic]", "orchestrate research"
- Any research task needing multiple perspectives and real depth
- NOT for quick factual questions — those are faster answered directly

## How to Run

The orchestrator script is at `${CLAUDE_SKILL_DIR}/../../orchestrate.js`.

```bash
# Standard (3 agents, 2 rounds)
node "${CLAUDE_SKILL_DIR}/../../orchestrate.js" "TOPIC"

# Quick (2 agents, single round)
node "${CLAUDE_SKILL_DIR}/../../orchestrate.js" "TOPIC" --agents 2 --single-round

# Deep (5 agents, 2 rounds)
node "${CLAUDE_SKILL_DIR}/../../orchestrate.js" "TOPIC" --agents 5

# Save to Obsidian
node "${CLAUDE_SKILL_DIR}/../../orchestrate.js" "TOPIC" --obsidian "/path/to/vault/Inbox/"
```

## Default Behavior

When the user asks to research a topic, ask depth preference:

| Mode | Flags | Est. Cost | Est. Time |
|------|-------|-----------|-----------|
| **Quick** | `--agents 2 --single-round` | ~$5 | ~10 min |
| **Standard** | `--agents 3` | ~$12 | ~20 min |
| **Deep** | `--agents 5` | ~$20 | ~25 min |
| **Thorough** | `--agents 5 --max-turns 35` | ~$28 | ~35 min |

Then run in background so the user can keep working. Report results when done.

## Important Notes

- Always run in background (`run_in_background: true`)
- Each agent is a separate Claude Code process consuming API quota
- Quality consistently scores 7.5-8.5/10 on the judge
- `--single-round` flag gives v2 behavior (no shared memory, cheaper)
- Cost breakdown is saved to `metrics.json` in the output dir
