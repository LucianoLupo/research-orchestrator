# Research Orchestrator v2: Instrumentation + Testing Plan

**Date:** 2026-03-16
**Status:** Draft
**Goal:** Make the orchestrator measurable, resilient, and proven through systematic testing.

---

## Phase 1: Instrumentation (Build)

Add observability and quality measurement to every run.

### 1.1 Cost & Token Tracking

**What:** Track token usage per agent and total cost per run.

**How:** Claude Code with `--output-format json` or parse `--verbose` output for token counts. Alternatively, wrap `claude` invocation and capture the usage summary it prints on exit.

**Output:** `output/<run>/metrics.json`
```json
{
  "topic": "...",
  "totalDurationMin": 14.2,
  "agents": [
    { "id": 0, "angle": "...", "durationMin": 8.8, "tokensIn": 45000, "tokensOut": 12000, "estimatedCost": "$0.85" },
    ...
  ],
  "synthesizer": { "durationMin": 4.9, "tokensIn": 30000, "tokensOut": 8000, "estimatedCost": "$0.55" },
  "totalEstimatedCost": "$3.40"
}
```

**Files touched:** `orchestrate.js` (spawn args, output parsing)

### 1.2 Judge Agent (Quality Self-Evaluation)

**What:** After synthesis, spawn a judge agent that scores the report on 5 dimensions.

**How:** New template `templates/judge.md`. Judge reads the final report + original topic and scores:

| Dimension | What It Measures | Scale |
|-----------|-----------------|-------|
| **Depth** | Beyond surface-level? Specific data, numbers, quotes? | 1-10 |
| **Accuracy** | Claims properly sourced? No hallucinated facts? | 1-10 |
| **Coverage** | Topic comprehensively covered? Major gaps? | 1-10 |
| **Synthesis** | True synthesis vs. concatenation? Cross-cutting insights? | 1-10 |
| **Actionability** | Useful takeaways? Could someone act on this? | 1-10 |

**Output:** `output/<run>/judge.json` + score appended to `metrics.json`

**Files:** New `templates/judge.md`, modify `orchestrate.js` (add judge phase)

### 1.3 Agent Failure Recovery

**What:** Handle individual agent failures gracefully.

**How:**
- If an agent fails, log the error but don't abort
- Retry once with reduced max-turns
- Synthesizer receives a manifest of which agents succeeded/failed
- Synthesizer notes gaps in the report

**Files:** `orchestrate.js` (retry logic, error handling)

### 1.4 Comparison Mode

**What:** `--compare` flag runs two configurations side-by-side and has the judge score both.

**How:**
```bash
node orchestrate.js "topic" --compare --agents 3,5
# Runs once with 3 agents, once with 5, judges both, prints comparison
```

**Output:** `output/<run>/comparison.json` with side-by-side scores

**Files:** `orchestrate.js` (comparison orchestration), new `templates/comparator.md`

---

## Phase 2: Testing (Run)

Systematic test suite to validate quality and find failure modes.

### 2.1 Quality Benchmark (Gold Standard)

**What:** Run on "Karpathy autoresearch" — a topic where we have a comprehensive 400-line expert-written report in Obsidian.

**How:**
```bash
node orchestrate.js "Karpathy autoresearch framework, autonomous AI agents, nanochat, and community ecosystem as of March 2026" --agents 3
```

**Evaluate:** Manually compare against `Karpathy Autoresearch - Deep Research Report.md`:
- What did the orchestrator find that the manual report missed?
- What did the manual report have that the orchestrator missed?
- Were there any factual errors?

**Success criteria:** Report covers ≥80% of the manual report's key points, with no major factual errors.

### 2.2 Scaling Test

**What:** Same topic, different agent counts. Does more agents = better?

**How:**
```bash
node orchestrate.js "ZK proof systems and privacy-preserving computation 2026" --compare --agents 2,5
node orchestrate.js "ZK proof systems and privacy-preserving computation 2026" --agents 7
```

**Measure:**
- Judge scores per run
- Cost per run
- Overlap between agents (do 7 agents waste effort?)
- Diminishing returns curve

**Hypothesis:** 3-5 agents is the sweet spot. 2 is too thin, 7+ causes overlap and wastes tokens.

### 2.3 Consistency Test

**What:** Same topic, run 3 times. How much does output vary?

**How:**
```bash
for i in 1 2 3; do
  node orchestrate.js "State of Rust async runtimes in 2026" --agents 3
done
```

**Measure:** Judge scores across runs, key findings overlap percentage.

**Hypothesis:** Scores should be within ±1.5 points. Core findings should overlap ≥70%.

### 2.4 Edge Cases

**What:** Topics designed to stress-test the system.

| Test | Topic | Why It's Hard |
|------|-------|--------------|
| **Narrow** | "CVE-2026-25253 OpenClaw RCE vulnerability technical analysis" | Very specific, might not split well into 3 angles |
| **Contradictory** | "Is multi-agent AI actually useful or just hype?" | Should surface both sides, not pick one |
| **Fast-moving** | "AI developments in the last 48 hours" | Tests web search recency |
| **Non-English** | "Estado del ecosistema crypto en Argentina 2026" | Spanish topic, mixed-language sources |
| **Huge** | "Complete history of artificial intelligence" | Too broad — should the splitter push back? |

### 2.5 Failure Injection

**What:** Deliberately cause failures and verify recovery.

**How:**
- Set `--max-turns 2` (agent can't finish in time)
- Run 5 agents when rate-limited (some should fail, others succeed)
- Kill a Claude process mid-run

**Measure:** Does the synthesizer still produce useful output from partial results?

---

## Phase 3: Iterate (Improve)

Based on test results, fix what's broken.

### Likely Improvements (Predicted)

1. **Splitter quality** — Probably needs few-shot examples in the template for better angle generation
2. **Researcher depth** — May need to explicitly instruct "use at least 5 web searches" and "read full articles, don't just summarize search results"
3. **Synthesizer quality** — May just concatenate instead of truly synthesizing. Fix with stronger template + examples
4. **Cost control** — Add `--max-cost` flag that kills agents if estimated cost exceeds budget
5. **Progress output** — Stream agent status to terminal in real-time instead of just logging start/end

---

## Execution Order

```
Phase 1.1 (cost tracking)      → ~30 min build
Phase 1.2 (judge agent)        → ~20 min build
Phase 1.3 (failure recovery)   → ~20 min build
Phase 2.1 (gold standard)      → ~15 min run + 15 min eval
Phase 2.4 (edge cases, narrow) → ~15 min run
Phase 2.2 (scaling test)       → ~30 min run (2 + 5 + 7 agents)
Phase 1.4 (comparison mode)    → ~30 min build (needs judge first)
Phase 2.3 (consistency test)   → ~45 min run (3x same topic)
Phase 2.5 (failure injection)  → ~20 min run
Phase 3   (iterate on findings) → variable
```

**Estimated total:** ~4 hours of build + run time. Can be spread across sessions.

**Cost estimate:** ~$15-30 in Claude API tokens for all test runs (rough guess based on $3-4 per 3-agent run).

---

## Success Criteria

The orchestrator is "proven" when:
- [ ] Gold standard benchmark: ≥80% coverage, zero major factual errors
- [ ] Judge scores average ≥7/10 across all dimensions
- [ ] 3 consistency runs score within ±1.5 points
- [ ] All edge cases produce usable output (no crashes, no empty reports)
- [ ] Failure injection: partial results still produce useful synthesis
- [ ] Cost per 3-agent run is documented and predictable
- [ ] Scaling test identifies optimal agent count
