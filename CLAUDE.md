# research-orchestrator

CLI tool that runs parallel deep research using multiple Claude Code instances with shared memory and iterative refinement.

**Tech Stack:** Node.js (ESM, zero dependencies), Claude Code CLI

---

## Architecture

```
orchestrate.js          ← Single-file orchestrator, all logic here
templates/              ← Prompt templates (Mustache-style {{VAR}} substitution)
  splitter.md           ← Decomposes topic into N research angles
  researcher.md         ← Round 1 agent instructions
  coordinator.md        ← Analyzes R1 findings, identifies gaps, builds shared memory
  researcher-round2.md  ← Round 2 agent instructions (gap-filling)
  synthesizer.md        ← Merges all findings into final report
  judge.md              ← Scores report quality on 5 dimensions
output/                 ← Run outputs (gitignored)
plans/                  ← Design docs for v2 and v3
```

### Pipeline

```
splitTopic() → runRound1() → coordinate() → runRound2() → synthesize() → judgeReport()
```

Each phase spawns Claude Code as a subprocess via `child_process.spawn` with `--output-format json` for structured output and cost tracking.

### Key patterns

- `runClaude()` — Core subprocess runner. Returns `{ result, usage }` with token/cost data parsed from JSON output.
- `runAgent()` — Wraps `runClaude()` with retry logic (one retry with reduced turns on failure).
- `CostTracker` — Accumulates per-phase costs, prints breakdown at end.
- `fillTemplate()` — Simple `{{VAR}}` replacement, no template engine dependency.
- Shared memory lives in `output/<run>/shared/` — agents read it before Round 2.

## Getting Started

```bash
node orchestrate.js "Your topic" --agents 3
```

Requires Claude Code CLI installed and authenticated. No `npm install` needed.

## Conventions

- Single-file architecture — all orchestration logic in `orchestrate.js`
- Templates are plain markdown with `{{VARIABLE}}` placeholders
- Output directories are timestamped: `output/YYYY-MM-DDTHH-MM-SS-research/`
- Every agent writes findings to its own directory (`agent-N/`)
- Shared state between rounds goes in `shared/`

## Common Tasks

### Adding a new pipeline phase

1. Create `templates/your-phase.md` with `{{VAR}}` placeholders
2. Add an `async function yourPhase()` in `orchestrate.js` following the pattern of `judgeReport()` or `coordinate()`
3. Call it from `main()` at the appropriate point in the pipeline
4. Add cost tracking: `costs.add("your-phase", usage)`

### Modifying agent behavior

Edit the relevant template in `templates/`. The templates are the prompts — changing them changes agent behavior directly.
