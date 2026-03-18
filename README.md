# research-orchestrator

Run deep, multi-agent research on any topic using parallel [Claude Code](https://docs.anthropic.com/en/docs/claude-code) instances with shared memory and iterative refinement.

Give it a topic. It splits it into angles, dispatches parallel researcher agents, identifies gaps, runs a second round to fill them, synthesizes everything into a single report, and scores the result.

```
Splitter ──► Round 1 (N agents in parallel)
                 │
            Coordinator (identify gaps, build shared memory)
                 │
             Round 2 (N agents fill gaps) ◄── optional
                 │
            Synthesizer (merge into one report)
                 │
              Judge (score on 5 dimensions)
```

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Node.js 18+

## Install

No npm dependencies — it's a single file with zero packages. Pick the method that fits your workflow.

### Method 1: Claude Code Plugin (recommended)

Install as a plugin and get the `/research-orchestrator` slash command:

```bash
/plugin marketplace add LucianoLupo/research-orchestrator
/plugin install research-orchestrator@research-orchestrator
```

Then use it from any Claude Code session:

```
/research-orchestrator "State of WebAssembly in 2026"
```

### Method 2: Standalone Skill

Clone the repo and run the installer to add it as a personal Claude Code skill:

```bash
git clone https://github.com/LucianoLupo/research-orchestrator.git ~/tools/research-orchestrator
~/tools/research-orchestrator/install.sh
```

This creates a skill at `~/.claude/skills/research-orchestrator/` pointing to the cloned repo. Use `/research-orchestrator` in Claude Code.

### Method 3: Direct CLI

Just clone and run — no Claude Code integration needed:

```bash
git clone https://github.com/LucianoLupo/research-orchestrator.git
cd research-orchestrator
node orchestrate.js "Your topic here"
```

This follows the [Agent Skills](https://agentskills.io) open standard, so the skill also works with Codex, Cursor, VS Code, and other compatible tools.

## Usage

```bash
node orchestrate.js "Your research topic here"
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--agents N` | 3 | Number of parallel research agents |
| `--max-turns N` | 25 | Max turns per agent in Round 1 |
| `--round2-turns N` | 15 | Max turns per agent in Round 2 |
| `--single-round` | off | Skip Round 2 (faster, cheaper) |
| `--no-judge` | off | Skip quality scoring |
| `--no-synthesize` | off | Skip synthesis (keep raw findings only) |
| `--obsidian PATH` | — | Copy final report to an Obsidian vault directory |
| `--angles-only` | off | Just split the topic into angles and exit |
| `--output DIR` | auto | Custom output directory |

### Presets

| Mode | Flags | Approx. cost | Approx. time |
|------|-------|-------------|-------------|
| Quick | `--agents 2 --single-round` | ~$5 | ~10 min |
| Standard | `--agents 3` | ~$12 | ~20 min |
| Deep | `--agents 5` | ~$20 | ~25 min |
| Thorough | `--agents 5 --max-turns 35` | ~$28 | ~35 min |

### Examples

```bash
# Standard 3-agent research with 2 rounds
node orchestrate.js "State of WebAssembly in 2026"

# Quick and cheap
node orchestrate.js "Rust async runtimes" --agents 2 --single-round

# Deep dive with 5 agents
node orchestrate.js "ZK proof systems and privacy-preserving computation" --agents 5

# Save report to Obsidian vault
node orchestrate.js "LLM fine-tuning techniques" --obsidian ~/Documents/Obsidian\ Vault/00_Inbox/
```

## How It Works

### 1. Splitter

Takes the topic and breaks it into N non-overlapping research angles, each with suggested search queries. Output: `angles.json`.

### 2. Round 1 — Parallel Research

Each agent gets one angle and researches it independently using web search. Agents are instructed to:
- Run 5-10+ web searches
- Read primary sources, not just search summaries
- Cross-reference claims across sources
- Never cite a URL they didn't actually fetch and verify

Output: `agent-N/findings.md` per agent.

### 3. Coordinator

Reads all Round 1 findings and produces shared memory:
- `shared/known-facts.md` — consolidated facts organized by theme
- `shared/sources.txt` — deduplicated list of all URLs fetched
- `shared/gaps.md` — what's missing, with assignments for Round 2
- `shared/round-1-summary.md` — quality assessment of Round 1

If no critical gaps are found, Round 2 is skipped.

### 4. Round 2 — Gap Filling

Agents re-deploy with access to shared memory. They're instructed to:
- Not duplicate Round 1 work
- Not re-fetch already-fetched URLs
- Focus specifically on gaps identified by the coordinator
- Go deeper on areas Round 1 only scratched

Output: `agent-N/findings-round2.md` per agent.

### 5. Synthesizer

Merges all findings (Round 1 + Round 2 + shared context) into a single coherent report. Synthesizes by theme, doesn't just concatenate. Deduplicates sources, flags contradictions.

Output: `report.md`.

### 6. Judge

Scores the final report on five dimensions (1-10 each):

| Dimension | What it measures |
|-----------|-----------------|
| **Depth** | Specific data, numbers, quotes vs. vague summaries |
| **Accuracy** | Claims properly sourced, no hallucinations |
| **Coverage** | Topic comprehensively covered, no major gaps |
| **Synthesis** | True synthesis vs. concatenation of facts |
| **Actionability** | Clear takeaways someone could act on |

Output: `judge.json`.

## Output Structure

Each run creates a timestamped directory:

```
output/2026-03-18T15-30-00-research/
├── config.json              # Run configuration
├── angles.json              # Research angles from splitter
├── agent-0/
│   ├── findings.md          # Round 1 findings
│   ├── findings-round2.md   # Round 2 findings (if applicable)
│   └── log.txt              # Agent output log
├── agent-1/
│   └── ...
├── agent-2/
│   └── ...
├── shared/
│   ├── known-facts.md       # Consolidated facts after Round 1
│   ├── sources.txt          # All URLs fetched (deduplicated)
│   ├── gaps.md              # Gaps identified by coordinator
│   └── round-1-summary.md   # Round 1 quality assessment
├── report.md                # Final synthesized report
├── judge.json               # Quality scores
└── metrics.json             # Cost, timing, and per-agent stats
```

## Source Integrity

All templates enforce strict source integrity rules:

- Agents must never cite a URL they didn't fetch and verify in the current session
- Failed URLs go in a "Failed Sources" section, not the main sources
- The synthesizer only includes URLs that appear in agent findings — it never adds its own
- Unverified claims are explicitly marked as such

This is the single most important quality rule in the system. LLMs hallucinate URLs constantly; these guardrails significantly reduce (but don't eliminate) that failure mode.

## Cost

Costs depend on the Claude model, number of agents, and turns. The orchestrator tracks costs per phase and prints a breakdown at the end:

```
=== RUN COMPLETE ===
Topic: "State of WebAssembly in 2026"
Rounds: 2
Duration: 18.3min
Cost: $11.2847
Cost breakdown:
  splitter: $0.0312
  r1-agent-0: $2.8431
  r1-agent-1: $3.1205
  r1-agent-2: $2.9877
  coordinator: $0.4521
  r2-agent-0: $0.6234
  r2-agent-1: $0.5891
  r2-agent-2: $0.5103
  synthesizer: $0.0982
  judge: $0.0291
  TOTAL: $11.2847
```

## Claude Code Integration

This repo ships as both a CLI tool and a Claude Code plugin/skill:

- **As a plugin**: Install via `/plugin marketplace add` (see [Install](#install)). The `/research-orchestrator` command becomes available with namespacing.
- **As a standalone skill**: Run `install.sh` to create a personal skill at `~/.claude/skills/research-orchestrator/`.
- **As a CLI**: Run `node orchestrate.js` directly — no Claude Code integration needed.

The skill follows the [Agent Skills](https://agentskills.io) open standard, making it compatible with Claude Code, Codex, Cursor, VS Code, and other tools that support the spec.

## License

MIT
