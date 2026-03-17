# Research Orchestrator v3: Shared Memory + Iterative Rounds

**Date:** 2026-03-17
**Status:** Implementing

---

## Design

### Current (v2): Fan-out/Fan-in
```
Split → [Agent 1, Agent 2, Agent 3] → Synthesize
         (no communication)
```
Problems: Agents duplicate work, fetch same URLs, can't build on each other's findings.

### New (v3): Iterative Rounds with Shared Memory
```
Round 1: [Agent 1, 2, 3] research independently → write to shared/
    ↓
Coordinator: read all findings, identify gaps, update shared context
    ↓
Round 2: [Agent 1, 2, 3] read shared/, research gaps → write updates
    ↓
Final synthesis (with full shared context)
```

### Shared Memory Structure
```
shared/
├── known-facts.md    # Growing summary of what's been discovered
├── sources.txt       # URLs already fetched (dedup)
├── gaps.md           # What's still unknown
└── round-1-summary.md # Coordinator's synthesis after round 1
```

### Key Principles
- Agents read shared state before starting each round
- Agents write findings back to shared state after each round
- Coordinator identifies gaps between rounds
- Round 2 agents get "don't duplicate, go deeper on gaps" instructions
- Source dedup prevents wasted fetches

### Tradeoff
- 2 rounds = ~1.5-2x cost (round 2 is cheaper — targeted, not exploratory)
- Quality should jump significantly — round 2 fills gaps instead of blind exploration
- Time: ~20-30 min total instead of ~15 min
