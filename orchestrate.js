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
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes per subprocess
const MAX_AGENTS = 20;
const CLAUDE_BIN = "claude";
const STDERR_CAP = 2048;

// --- Process tracking for graceful shutdown ---
const activeProcs = new Set();

function cleanupAndExit(signal) {
  log(`Caught ${signal}, killing ${activeProcs.size} child process(es)...`);
  for (const proc of activeProcs) {
    proc.kill("SIGTERM");
  }
  process.exit(1);
}

process.on("SIGINT", () => cleanupAndExit("SIGINT"));
process.on("SIGTERM", () => cleanupAndExit("SIGTERM"));

// --- Helpers ---

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function sanitizeForFilename(str) {
  return str.replace(/[\/\\:*?"<>|]/g, "_").slice(0, 60);
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

function runClaude(prompt, { maxTurns, cwd, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let settled = false;

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
    });

    activeProcs.add(proc);

    const stdoutChunks = [];
    let stderrHead = "";

    proc.stdout.on("data", (d) => {
      stdoutChunks.push(d);
    });
    proc.stderr.on("data", (d) => {
      if (stderrHead.length < STDERR_CAP) {
        stderrHead += d.toString();
        if (stderrHead.length > STDERR_CAP) {
          stderrHead = stderrHead.slice(0, STDERR_CAP);
        }
      }
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGTERM");
        activeProcs.delete(proc);
        reject(new Error(`Claude subprocess timed out after ${timeoutMs / 1000}s`));
      }
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      activeProcs.delete(proc);
      if (settled) return;
      settled = true;

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");

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
          log("WARNING: Claude output was not valid JSON. Cost tracking may be inaccurate.");
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
              `Claude exited with code ${code}\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderrHead.slice(0, 500)}`
            )
          );
        }
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      activeProcs.delete(proc);
      if (!settled) {
        settled = true;
        reject(new Error(`Failed to spawn Claude: ${err.message}`));
      }
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
        mergedUsage.cacheCreation += firstErr.usage.cacheCreation ?? 0;
        mergedUsage.cacheRead += firstErr.usage.cacheRead ?? 0;
      }
      return { success: true, retried: true, result, usage: mergedUsage, elapsed };
    } catch (retryErr) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      const failedCost =
        (firstErr.usage?.costUsd ?? 0) + (retryErr.usage?.costUsd ?? 0);
      return {
        success: false,
        error: `${firstErr.message} | Retry: ${retryErr.message}`,
        usage: { costUsd: failedCost, inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0 },
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

  const res = await runAgent("splitter", prompt, {
    maxTurns: 5,
    cwd: __dirname,
    retryTurns: 3,
  });

  if (res.usage) costs.add("splitter", res.usage);
  log(`Splitter: $${res.usage?.costUsd?.toFixed(4) ?? "?"}`);

  if (!res.success) {
    log(`Splitter failed: ${res.error}. Using generic angles.`);
    return Array.from({ length: numAgents }, (_, i) => ({
      id: i,
      angle: `Research angle ${i + 1}`,
      description: `Research aspect ${i + 1} of: ${topic}`,
      search_queries: [topic],
    }));
  }

  let jsonStr = res.result;
  const fenceMatch = res.result.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) jsonStr = fenceMatch[1];
  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (arrayMatch) jsonStr = arrayMatch[0];

  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    log(`Splitter parse failed (${err.message}), using generic angles`);
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
      try {
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

        const logContent = res.success
          ? (res.result ?? "Agent completed but returned no text output")
          : `ERROR: ${res.error ?? "Unknown error"}`;
        await writeFile(join(agentDir, "log.txt"), String(logContent), "utf-8");

        return { ...res, agentId: angle.id, angle: angle.angle };
      } catch (err) {
        logAgent(angle.id, `R1 FAIL (unexpected): ${err.message}`);
        return { success: false, error: err.message, usage: null, elapsed: "?", agentId: angle.id, angle: angle.angle };
      }
    })
  );

  const ok = results.filter((r) => r.success).length;
  log(`Round 1 complete: ${ok}/${results.length} succeeded`);
  return results;
}

// --- Phase 3: Coordinator — Analyze gaps, build shared memory ---

async function coordinate(topic, outputDir, round1Results, costs) {
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

  if (res.success && (await fileExists(join(sharedDir, "gaps.md")))) {
    const gaps = await readFile(join(sharedDir, "gaps.md"), "utf-8");
    const hasCritical = /##\s*critical\s+gaps/i.test(gaps);
    if (hasCritical) {
      log("Coordinator found critical gaps → proceeding to Round 2");
    } else {
      log("Coordinator found no critical gaps → skipping Round 2");
    }
    return hasCritical;
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
      try {
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
          await writeFile(join(agentDir, "log-round2.txt"), String(res.result ?? "Agent completed"), "utf-8");
        }

        return { ...res, agentId: angle.id, angle: angle.angle };
      } catch (err) {
        logAgent(angle.id, `R2 FAIL (unexpected): ${err.message}`);
        return { success: false, error: err.message, usage: null, elapsed: "?", agentId: angle.id, angle: angle.angle };
      }
    })
  );

  const ok = results.filter((r) => r.success).length;
  log(`Round 2 complete: ${ok}/${results.length} succeeded`);
  return results;
}

// --- Phase 5: Synthesize (aware of both rounds) ---

async function synthesize(topic, outputDir, angles, round1Results, round2Results, costs) {
  log("--- SYNTHESIZER: Merging all findings ---");

  const sharedDir = join(outputDir, "shared");
  const rounds = round2Results ? 2 : 1;

  // Collect all findings files (round 1 + round 2)
  const pathCandidates = [];
  for (const r of [...round1Results, ...(round2Results ?? [])]) {
    if (!r.success) continue;
    pathCandidates.push(join(outputDir, `agent-${r.agentId}`, "findings.md"));
    pathCandidates.push(join(outputDir, `agent-${r.agentId}`, "findings-round2.md"));
  }
  const knownFacts = join(sharedDir, "known-facts.md");
  pathCandidates.push(knownFacts);

  const uniquePaths = [...new Set(pathCandidates)];
  const existResults = await Promise.all(
    uniquePaths.map((p) => fileExists(p).then((exists) => (exists ? p : null)))
  );
  const findingsPaths = existResults.filter(Boolean);

  if (findingsPaths.length === 0) {
    log("No findings to synthesize.");
    return null;
  }

  const reportPath = join(outputDir, "report.md");
  const date = new Date().toISOString().slice(0, 10);

  const template = await loadTemplate("synthesizer.md");
  const prompt = fillTemplate(template, {
    TOPIC: topic,
    FINDINGS_PATHS: findingsPaths.map((p) => `- ${p}`).join("\n"),
    OUTPUT_PATH: reportPath,
    DATE: date,
    NUM_AGENTS: String(angles.length),
    NUM_ROUNDS: String(rounds),
  });

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

// --- Arg parsing ---

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
research-orchestrator v3 — Parallel deep research with shared memory

Usage:
  node orchestrate.js "Your research topic" [options]

Options:
  --agents N          Number of parallel research agents (default: ${DEFAULT_NUM_AGENTS}, max: ${MAX_AGENTS})
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

  const topic = args[0];
  if (topic.startsWith("--")) {
    console.error(`Error: First argument must be the research topic, got "${topic}"`);
    process.exit(1);
  }

  const config = {
    topic,
    numAgents: DEFAULT_NUM_AGENTS,
    maxTurns: DEFAULT_MAX_TURNS,
    round2Turns: DEFAULT_ROUND2_TURNS,
    singleRound: false,
    noJudge: false,
    noSynthesize: false,
    obsidianPath: null,
    anglesOnly: false,
    customOutput: null,
  };

  const knownFlags = new Set([
    "--agents", "--max-turns", "--round2-turns", "--single-round",
    "--no-judge", "--no-synthesize", "--obsidian", "--angles-only", "--output",
  ]);

  for (let i = 1; i < args.length; i++) {
    if (!knownFlags.has(args[i])) {
      console.error(`Error: Unknown flag "${args[i]}". Run with --help to see options.`);
      process.exit(1);
    }

    switch (args[i]) {
      case "--agents":
        config.numAgents = parseInt(args[++i], 10);
        break;
      case "--max-turns":
        config.maxTurns = parseInt(args[++i], 10);
        break;
      case "--round2-turns":
        config.round2Turns = parseInt(args[++i], 10);
        break;
      case "--single-round":
        config.singleRound = true;
        break;
      case "--no-judge":
        config.noJudge = true;
        break;
      case "--no-synthesize":
        config.noSynthesize = true;
        break;
      case "--obsidian":
        config.obsidianPath = args[++i];
        break;
      case "--angles-only":
        config.anglesOnly = true;
        break;
      case "--output":
        config.customOutput = args[++i];
        break;
    }
  }

  // Validate numeric args
  if (isNaN(config.numAgents) || config.numAgents < 1 || config.numAgents > MAX_AGENTS) {
    console.error(`Error: --agents must be between 1 and ${MAX_AGENTS}, got "${config.numAgents}"`);
    process.exit(1);
  }
  if (isNaN(config.maxTurns) || config.maxTurns < 1) {
    console.error(`Error: --max-turns must be a positive number, got "${config.maxTurns}"`);
    process.exit(1);
  }
  if (isNaN(config.round2Turns) || config.round2Turns < 1) {
    console.error(`Error: --round2-turns must be a positive number, got "${config.round2Turns}"`);
    process.exit(1);
  }
  if (config.obsidianPath === undefined) {
    console.error("Error: --obsidian requires a path argument");
    process.exit(1);
  }
  if (config.customOutput === undefined) {
    console.error("Error: --output requires a path argument");
    process.exit(1);
  }

  return config;
}

// --- Main ---

async function main() {
  const config = parseArgs(process.argv);
  const {
    topic, numAgents, maxTurns, round2Turns, singleRound,
    noJudge, noSynthesize, obsidianPath, anglesOnly, customOutput,
  } = config;

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
  if (!singleRound) {
    log("===");
    const hasGaps = await coordinate(topic, outputDir, r1Results, costs);

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
          `Research - ${sanitizeForFilename(topic)}.md`
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

  try {
    await writeFile(
      join(outputDir, "metrics.json"),
      JSON.stringify(metrics, null, 2)
    );
  } catch (err) {
    log(`WARNING: Failed to write metrics.json: ${err.message}`);
  }

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
