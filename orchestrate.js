#!/usr/bin/env node

import { spawn } from "child_process";
import { readFile, writeFile, mkdir, access } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "templates");

// --- Config ---
const DEFAULT_NUM_AGENTS = 3;
const DEFAULT_MAX_TURNS = 25;
const DEFAULT_ROUND2_TURNS = 15;
const DEFAULT_RETRY_TURNS = 10;
const CLAUDE_BIN = "claude";

// --- Helpers ---

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

function logAgent(id, msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] [agent-${id}] ${msg}`);
}

async function loadTemplate(name) {
  return readFile(join(TEMPLATES_DIR, name), "utf-8");
}

function fillTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// --- Claude Runner with JSON output + cost tracking ---

function runClaude(prompt, { maxTurns, cwd }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--dangerously-skip-permissions",
      "--max-turns",
      String(maxTurns),
      "--output-format",
      "json",
      "-p",
      prompt,
    ];

    const proc = spawn(CLAUDE_BIN, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    proc.on("close", (code) => {
      try {
        const parsed = JSON.parse(stdout);
        const usage = {
          inputTokens: parsed.usage?.input_tokens ?? 0,
          outputTokens: parsed.usage?.output_tokens ?? 0,
          cacheCreation: parsed.usage?.cache_creation_input_tokens ?? 0,
          cacheRead: parsed.usage?.cache_read_input_tokens ?? 0,
          costUsd: parsed.total_cost_usd ?? 0,
          durationMs: parsed.duration_ms ?? 0,
          numTurns: parsed.num_turns ?? 0,
        };

        if (parsed.is_error || code !== 0) {
          const err = new Error(
            parsed.result || `Claude exited with code ${code}`
          );
          err.usage = usage;
          reject(err);
        } else {
          resolve({ result: parsed.result, usage });
        }
      } catch {
        if (code === 0 && stdout.trim()) {
          resolve({
            result: stdout.trim(),
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheCreation: 0,
              cacheRead: 0,
              costUsd: 0,
              durationMs: 0,
              numTurns: 0,
            },
          });
        } else {
          reject(
            new Error(
              `Claude exited with code ${code}\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`
            )
          );
        }
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn Claude: ${err.message}`));
    });
  });
}

// --- Cost accumulator ---

class CostTracker {
  constructor() {
    this.phases = [];
  }
  add(phase, usage) {
    this.phases.push({ phase, ...usage });
  }
  get total() {
    return this.phases.reduce((s, p) => s + (p.costUsd ?? 0), 0);
  }
  summary() {
    const lines = this.phases.map(
      (p) => `  ${p.phase}: $${(p.costUsd ?? 0).toFixed(4)}`
    );
    lines.push(`  TOTAL: $${this.total.toFixed(4)}`);
    return lines.join("\n");
  }
}

// --- Agent runner with retry ---

async function runAgent(label, prompt, { maxTurns, cwd, retryTurns }) {
  const startTime = Date.now();

  try {
    const { result, usage } = await runClaude(prompt, { maxTurns, cwd });
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    return { success: true, result, usage, elapsed };
  } catch (firstErr) {
    if (!retryTurns) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      return {
        success: false,
        error: firstErr.message,
        usage: firstErr.usage ?? null,
        elapsed,
      };
    }

    log(`${label} failed, retrying with ${retryTurns} turns...`);

    try {
      const { result, usage } = await runClaude(prompt, {
        maxTurns: retryTurns,
        cwd,
      });
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      const mergedUsage = { ...usage };
      if (firstErr.usage) {
        mergedUsage.costUsd += firstErr.usage.costUsd;
        mergedUsage.inputTokens += firstErr.usage.inputTokens;
        mergedUsage.outputTokens += firstErr.usage.outputTokens;
      }
      return { success: true, retried: true, result, usage: mergedUsage, elapsed };
    } catch (retryErr) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      const failedCost =
        (firstErr.usage?.costUsd ?? 0) + (retryErr.usage?.costUsd ?? 0);
      return {
        success: false,
        error: `${firstErr.message} | Retry: ${retryErr.message}`,
        usage: { costUsd: failedCost, inputTokens: 0, outputTokens: 0 },
        elapsed,
      };
    }
  }
}

// --- Phase 1: Split topic into angles ---

async function splitTopic(topic, numAgents, costs) {
  log(`Splitting topic into ${numAgents} research angles...`);

  const template = await loadTemplate("splitter.md");
  const prompt = fillTemplate(template, {
    TOPIC: topic,
    NUM_AGENTS: String(numAgents),
  });

  const { result, usage } = await runClaude(prompt, {
    maxTurns: 5,
    cwd: __dirname,
  });
  costs.add("splitter", usage);
  log(`Splitter: $${usage.costUsd.toFixed(4)}`);

  let jsonStr = result;
  const fenceMatch = result.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) jsonStr = fenceMatch[1];
  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (arrayMatch) jsonStr = arrayMatch[0];

  try {
    return JSON.parse(jsonStr);
  } catch {
    log(`Splitter parse failed, using generic angles`);
    return Array.from({ length: numAgents }, (_, i) => ({
      id: i,
      angle: `Research angle ${i + 1}`,
      description: `Research aspect ${i + 1} of: ${topic}`,
      search_queries: [topic],
    }));
  }
}

// --- Phase 2: Round 1 — Parallel research ---

async function runRound1(topic, angles, outputDir, maxTurns, costs) {
  log(`--- ROUND 1: ${angles.length} agents researching in parallel ---`);

  const template = await loadTemplate("researcher.md");
  const results = await Promise.all(
    angles.map(async (angle) => {
      const agentDir = join(outputDir, `agent-${angle.id}`);
      const outputPath = join(agentDir, "findings.md");
      await mkdir(agentDir, { recursive: true });

      logAgent(angle.id, `R1 starting: "${angle.angle}"`);

      const prompt = fillTemplate(template, {
        TOPIC: topic,
        ANGLE_NAME: angle.angle,
        ANGLE_DESCRIPTION: angle.description,
        SEARCH_QUERIES: angle.search_queries.join(", "),
        OUTPUT_PATH: outputPath,
        MAX_TURNS: String(maxTurns),
      });

      const res = await runAgent(`agent-${angle.id}`, prompt, {
        maxTurns,
        cwd: agentDir,
        retryTurns: DEFAULT_RETRY_TURNS,
      });

      if (res.usage) costs.add(`r1-agent-${angle.id}`, res.usage);

      const status = res.success
        ? res.retried
          ? "OK (retried)"
          : "OK"
        : "FAIL";
      const cost = res.usage?.costUsd?.toFixed(4) ?? "?";
      logAgent(angle.id, `R1 ${status} (${res.elapsed}min, $${cost}): "${angle.angle}"`);

      if (res.success) {
        await writeFile(join(agentDir, "log.txt"), res.result, "utf-8");
      } else {
        await writeFile(
          join(agentDir, "log.txt"),
          `ERROR: ${res.error}`,
          "utf-8"
        );
      }

      return { ...res, agentId: angle.id, angle: angle.angle };
    })
  );

  const ok = results.filter((r) => r.success).length;
  log(`Round 1 complete: ${ok}/${results.length} succeeded`);
  return results;
}

// --- Phase 3: Coordinator — Analyze gaps, build shared memory ---

async function coordinate(topic, _angles, outputDir, round1Results, costs) {
  log("--- COORDINATOR: Analyzing findings, identifying gaps ---");

  const sharedDir = join(outputDir, "shared");
  await mkdir(sharedDir, { recursive: true });

  const succeeded = round1Results.filter((r) => r.success);
  const findingsPaths = [];
  for (const r of succeeded) {
    const p = join(outputDir, `agent-${r.agentId}`, "findings.md");
    if (await fileExists(p)) findingsPaths.push(p);
  }

  if (findingsPaths.length === 0) {
    log("No findings to coordinate — all agents failed.");
    return false;
  }

  const template = await loadTemplate("coordinator.md");
  const prompt = fillTemplate(template, {
    TOPIC: topic,
    FINDINGS_PATHS: findingsPaths.map((p) => `- ${p}`).join("\n"),
    KNOWN_FACTS_PATH: join(sharedDir, "known-facts.md"),
    SOURCES_PATH: join(sharedDir, "sources.txt"),
    GAPS_PATH: join(sharedDir, "gaps.md"),
    SUMMARY_PATH: join(sharedDir, "round-1-summary.md"),
  });

  const res = await runAgent("coordinator", prompt, {
    maxTurns: 10,
    cwd: outputDir,
    retryTurns: null,
  });

  if (res.usage) costs.add("coordinator", res.usage);
  const cost = res.usage?.costUsd?.toFixed(4) ?? "?";
  log(`Coordinator: ${res.success ? "OK" : "FAIL"} (${res.elapsed}min, $${cost})`);

  // Check if gaps file was created and has content
  if (res.success && (await fileExists(join(sharedDir, "gaps.md")))) {
    const gaps = await readFile(join(sharedDir, "gaps.md"), "utf-8");
    const criticalGaps = (gaps.match(/## Critical Gaps/i) || []).length > 0;
    if (criticalGaps) {
      log("Coordinator found critical gaps → proceeding to Round 2");
    } else {
      log("Coordinator found no critical gaps → skipping Round 2");
    }
    return criticalGaps;
  }

  return false;
}

// --- Phase 4: Round 2 — Gap-filling with shared memory ---

async function runRound2(topic, angles, outputDir, round2Turns, costs) {
  log(`--- ROUND 2: ${angles.length} agents filling gaps ---`);

  const sharedDir = join(outputDir, "shared");
  const template = await loadTemplate("researcher-round2.md");

  const results = await Promise.all(
    angles.map(async (angle) => {
      const agentDir = join(outputDir, `agent-${angle.id}`);
      const outputPath = join(agentDir, "findings-round2.md");

      logAgent(angle.id, `R2 starting: "${angle.angle}"`);

      const prompt = fillTemplate(template, {
        TOPIC: topic,
        ANGLE_NAME: angle.angle,
        ANGLE_DESCRIPTION: angle.description,
        SHARED_KNOWN_FACTS: join(sharedDir, "known-facts.md"),
        SHARED_SOURCES: join(sharedDir, "sources.txt"),
        SHARED_GAPS: join(sharedDir, "gaps.md"),
        OUTPUT_PATH: outputPath,
        MAX_TURNS: String(round2Turns),
      });

      const res = await runAgent(`agent-${angle.id}-r2`, prompt, {
        maxTurns: round2Turns,
        cwd: agentDir,
        retryTurns: null,
      });

      if (res.usage) costs.add(`r2-agent-${angle.id}`, res.usage);

      const status = res.success ? "OK" : "FAIL";
      const cost = res.usage?.costUsd?.toFixed(4) ?? "?";
      logAgent(angle.id, `R2 ${status} (${res.elapsed}min, $${cost}): "${angle.angle}"`);

      if (res.success) {
        await writeFile(join(agentDir, "log-round2.txt"), res.result, "utf-8");
      }

      return { ...res, agentId: angle.id, angle: angle.angle };
    })
  );

  const ok = results.filter((r) => r.success).length;
  log(`Round 2 complete: ${ok}/${results.length} succeeded`);
  return results;
}

// --- Phase 5: Synthesize (aware of both rounds) ---

async function synthesize(topic, outputDir, angles, round1Results, round2Results, costs) {
  log("--- SYNTHESIZER: Merging all findings ---");

  const findingsPaths = [];
  const sharedDir = join(outputDir, "shared");

  // Collect all findings files (round 1 + round 2)
  for (const r of [...round1Results, ...(round2Results ?? [])]) {
    if (!r.success) continue;
    const r1 = join(outputDir, `agent-${r.agentId}`, "findings.md");
    const r2 = join(outputDir, `agent-${r.agentId}`, "findings-round2.md");
    if (await fileExists(r1) && !findingsPaths.includes(r1)) findingsPaths.push(r1);
    if (await fileExists(r2)) findingsPaths.push(r2);
  }

  // Also include shared context if available
  const knownFacts = join(sharedDir, "known-facts.md");
  if (await fileExists(knownFacts)) findingsPaths.push(knownFacts);

  if (findingsPaths.length === 0) {
    log("No findings to synthesize.");
    return null;
  }

  const reportPath = join(outputDir, "report.md");
  const date = new Date().toISOString().slice(0, 10);
  const rounds = round2Results ? 2 : 1;

  const template = await loadTemplate("synthesizer.md");
  const prompt = fillTemplate(template, {
    TOPIC: topic,
    FINDINGS_PATHS: findingsPaths.map((p) => `- ${p}`).join("\n"),
    OUTPUT_PATH: reportPath,
    DATE: date,
    NUM_AGENTS: String(angles.length),
  }) + `\n\nNOTE: This research was conducted in ${rounds} round(s) with ${angles.length} agents. Round 2 findings (if present) represent gap-filling research that should be weighted equally with Round 1.`;

  const res = await runAgent("synthesizer", prompt, {
    maxTurns: 15,
    cwd: outputDir,
    retryTurns: null,
  });

  if (res.usage) costs.add("synthesizer", res.usage);
  const cost = res.usage?.costUsd?.toFixed(4) ?? "?";
  log(`Synthesizer: ${res.success ? "OK" : "FAIL"} (${res.elapsed}min, $${cost})`);

  return res.success ? reportPath : null;
}

// --- Phase 6: Judge ---

async function judgeReport(topic, reportPath, outputDir, costs) {
  log("--- JUDGE: Scoring report quality ---");

  const template = await loadTemplate("judge.md");
  const judgePath = join(outputDir, "judge.json");

  const prompt = fillTemplate(template, {
    TOPIC: topic,
    REPORT_PATH: reportPath,
    OUTPUT_PATH: judgePath,
  });

  const res = await runAgent("judge", prompt, {
    maxTurns: 10,
    cwd: outputDir,
    retryTurns: null,
  });

  if (res.usage) costs.add("judge", res.usage);

  if (res.success && (await fileExists(judgePath))) {
    try {
      const raw = await readFile(judgePath, "utf-8");
      const scores = JSON.parse(raw);
      log("--- QUALITY SCORES ---");
      for (const [dim, val] of Object.entries(scores.scores || {})) {
        log(`  ${dim}: ${val}/10`);
      }
      if (scores.overall) log(`  OVERALL: ${scores.overall}/10`);
      if (scores.summary) log(`  Summary: ${scores.summary}`);
      log("---------------------");
      return scores;
    } catch {
      log("Judge output not valid JSON");
    }
  }
  return null;
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
research-orchestrator v3 — Parallel deep research with shared memory

Usage:
  node orchestrate.js "Your research topic" [options]

Options:
  --agents N          Number of parallel research agents (default: ${DEFAULT_NUM_AGENTS})
  --max-turns N       Max turns per agent in Round 1 (default: ${DEFAULT_MAX_TURNS})
  --round2-turns N    Max turns per agent in Round 2 (default: ${DEFAULT_ROUND2_TURNS})
  --single-round      Skip Round 2 (v2 behavior — faster, cheaper)
  --no-judge          Skip quality judgment
  --no-synthesize     Skip synthesis
  --obsidian PATH     Copy final report to Obsidian vault path
  --angles-only       Just split topic into angles and exit
  --output DIR        Custom output directory

Modes:
  Quick:     --agents 2 --single-round          (~$5, ~10 min)
  Standard:  --agents 3                          (~$12, ~20 min)
  Deep:      --agents 5                          (~$20, ~25 min)
  Thorough:  --agents 5 --max-turns 35           (~$28, ~35 min)

Examples:
  node orchestrate.js "autoresearch trend March 2026"
  node orchestrate.js "Rust async runtimes" --agents 5
  node orchestrate.js "quick topic" --agents 2 --single-round
  node orchestrate.js "ZK proofs 2026" --obsidian ~/Documents/Obsidian\\ Vault/00_Inbox/
`);
    process.exit(0);
  }

  // Parse args
  const topic = args[0];
  let numAgents = DEFAULT_NUM_AGENTS;
  let maxTurns = DEFAULT_MAX_TURNS;
  let round2Turns = DEFAULT_ROUND2_TURNS;
  let singleRound = false;
  let noJudge = false;
  let noSynthesize = false;
  let obsidianPath = null;
  let anglesOnly = false;
  let customOutput = null;

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--agents":
        numAgents = parseInt(args[++i], 10);
        break;
      case "--max-turns":
        maxTurns = parseInt(args[++i], 10);
        break;
      case "--round2-turns":
        round2Turns = parseInt(args[++i], 10);
        break;
      case "--single-round":
        singleRound = true;
        break;
      case "--no-judge":
        noJudge = true;
        break;
      case "--no-synthesize":
        noSynthesize = true;
        break;
      case "--obsidian":
        obsidianPath = args[++i];
        break;
      case "--angles-only":
        anglesOnly = true;
        break;
      case "--output":
        customOutput = args[++i];
        break;
    }
  }

  const runStart = Date.now();
  const costs = new CostTracker();
  const outputDir =
    customOutput || join(__dirname, "output", `${timestamp()}-research`);
  await mkdir(outputDir, { recursive: true });
  await mkdir(join(outputDir, "shared"), { recursive: true });

  log(`Research Orchestrator v3 ${singleRound ? "(single round)" : "(2 rounds)"}`);
  log(`Topic: "${topic}"`);
  log(`Agents: ${numAgents} | R1 turns: ${maxTurns} | R2 turns: ${round2Turns}`);
  log(`Output: ${outputDir}`);
  log("===");

  await writeFile(
    join(outputDir, "config.json"),
    JSON.stringify(
      {
        topic,
        numAgents,
        maxTurns,
        round2Turns,
        singleRound,
        startedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  // Phase 1: Split
  const angles = await splitTopic(topic, numAgents, costs);
  await writeFile(
    join(outputDir, "angles.json"),
    JSON.stringify(angles, null, 2)
  );

  log("Research angles:");
  for (const a of angles) log(`  ${a.id}: ${a.angle}`);

  if (anglesOnly) {
    log("Angles-only mode, exiting.");
    process.exit(0);
  }

  // Phase 2: Round 1
  log("===");
  const r1Results = await runRound1(topic, angles, outputDir, maxTurns, costs);

  const r1ok = r1Results.filter((r) => r.success).length;
  if (r1ok === 0) {
    log("All agents failed in Round 1. Aborting.");
    process.exit(1);
  }

  // Phase 3: Coordinator + Phase 4: Round 2 (unless --single-round)
  let r2Results = null;
  if (!singleRound && r1ok > 0) {
    log("===");
    const hasGaps = await coordinate(topic, angles, outputDir, r1Results, costs);

    if (hasGaps) {
      log("===");
      r2Results = await runRound2(topic, angles, outputDir, round2Turns, costs);
    }
  }

  // Phase 5: Synthesize
  let reportPath = null;
  if (!noSynthesize) {
    log("===");
    reportPath = await synthesize(
      topic,
      outputDir,
      angles,
      r1Results,
      r2Results,
      costs
    );

    if (reportPath && obsidianPath) {
      try {
        const report = await readFile(reportPath, "utf-8");
        const obsFile = join(
          obsidianPath,
          `Research - ${topic.slice(0, 60)}.md`
        );
        await writeFile(obsFile, report);
        log(`Copied to Obsidian: ${obsFile}`);
      } catch (err) {
        log(`Obsidian copy failed: ${err.message}`);
      }
    }
  }

  // Phase 6: Judge
  let judgeScores = null;
  if (!noJudge && reportPath && (await fileExists(reportPath))) {
    log("===");
    judgeScores = await judgeReport(topic, reportPath, outputDir, costs);
  }

  // Save metrics
  const totalMin = ((Date.now() - runStart) / 1000 / 60).toFixed(1);

  const metrics = {
    topic,
    numAgents,
    maxTurns,
    round2Turns,
    singleRound,
    rounds: r2Results ? 2 : 1,
    totalDurationMin: parseFloat(totalMin),
    totalCostUsd: parseFloat(costs.total.toFixed(4)),
    costBreakdown: costs.phases,
    agents: angles.map((a) => {
      const r1 = r1Results.find((r) => r.agentId === a.id);
      const r2 = r2Results?.find((r) => r.agentId === a.id);
      return {
        id: a.id,
        angle: a.angle,
        round1: {
          success: r1?.success ?? false,
          elapsed: r1?.elapsed,
          costUsd: r1?.usage?.costUsd ?? 0,
        },
        round2: r2
          ? {
              success: r2.success,
              elapsed: r2.elapsed,
              costUsd: r2.usage?.costUsd ?? 0,
            }
          : null,
      };
    }),
    judge: judgeScores,
  };

  await writeFile(
    join(outputDir, "metrics.json"),
    JSON.stringify(metrics, null, 2)
  );

  // Final summary
  log("===");
  log("=== RUN COMPLETE ===");
  log(`Topic: "${topic}"`);
  log(`Rounds: ${metrics.rounds}`);
  log(`Duration: ${totalMin}min`);
  log(`Cost: $${costs.total.toFixed(4)}`);
  log("Cost breakdown:");
  log(costs.summary());
  if (judgeScores?.overall) log(`Quality: ${judgeScores.overall}/10`);
  log(`Results: ${outputDir}`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
