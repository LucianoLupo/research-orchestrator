#!/usr/bin/env node

import { spawn } from "child_process";
import { readFile, writeFile, mkdir, access } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "templates");

// --- Config ---
const DEFAULT_NUM_AGENTS = 3;
const DEFAULT_MAX_TURNS = 30;
const DEFAULT_RETRY_TURNS = 15;
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

// --- Claude Runner with JSON output ---

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
          // Fallback: non-JSON output
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

// --- Phase 1: Split topic into angles ---

async function splitTopic(topic, numAgents) {
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

  log(`Splitter cost: $${usage.costUsd.toFixed(4)} | ${usage.numTurns} turns`);

  // Extract JSON from the response
  let jsonStr = result;
  const fenceMatch = result.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1];
  }

  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    jsonStr = arrayMatch[0];
  }

  try {
    const angles = JSON.parse(jsonStr);
    log(`Got ${angles.length} research angles`);
    return { angles, usage };
  } catch {
    log(`Failed to parse splitter output, using generic angles`);
    log(`Raw output: ${result.slice(0, 500)}`);
    return {
      angles: Array.from({ length: numAgents }, (_, i) => ({
        id: i,
        angle: `Research angle ${i + 1}`,
        description: `Research aspect ${i + 1} of: ${topic}`,
        search_queries: [topic],
      })),
      usage,
    };
  }
}

// --- Phase 2: Run parallel research agents (with retry) ---

async function runResearchAgent(topic, angle, outputDir, maxTurns) {
  const agentId = angle.id;
  const agentDir = join(outputDir, `agent-${agentId}`);
  const outputPath = join(agentDir, "findings.md");
  const logPath = join(agentDir, "log.txt");

  await mkdir(agentDir, { recursive: true });

  logAgent(agentId, `Starting: "${angle.angle}"`);
  const startTime = Date.now();

  const template = await loadTemplate("researcher.md");
  const prompt = fillTemplate(template, {
    TOPIC: topic,
    ANGLE_NAME: angle.angle,
    ANGLE_DESCRIPTION: angle.description,
    SEARCH_QUERIES: angle.search_queries.join(", "),
    OUTPUT_PATH: outputPath,
    MAX_TURNS: String(maxTurns),
  });

  // First attempt
  try {
    const { result, usage } = await runClaude(prompt, {
      maxTurns,
      cwd: agentDir,
    });

    await writeFile(logPath, result, "utf-8");
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    logAgent(
      agentId,
      `Done in ${elapsed}min ($${usage.costUsd.toFixed(4)}): "${angle.angle}"`
    );

    return { agentId, angle: angle.angle, success: true, elapsed, usage };
  } catch (firstErr) {
    const firstElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    logAgent(
      agentId,
      `FAILED after ${firstElapsed}min: ${firstErr.message.slice(0, 100)}`
    );

    // Retry with reduced turns
    logAgent(agentId, `Retrying with ${DEFAULT_RETRY_TURNS} turns...`);
    try {
      const { result, usage } = await runClaude(prompt, {
        maxTurns: DEFAULT_RETRY_TURNS,
        cwd: agentDir,
      });

      await writeFile(logPath, result, "utf-8");
      const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      logAgent(
        agentId,
        `Retry succeeded in ${totalElapsed}min ($${usage.costUsd.toFixed(4)}): "${angle.angle}"`
      );

      // Merge usage from failed attempt if available
      const mergedUsage = { ...usage };
      if (firstErr.usage) {
        mergedUsage.costUsd += firstErr.usage.costUsd;
        mergedUsage.inputTokens += firstErr.usage.inputTokens;
        mergedUsage.outputTokens += firstErr.usage.outputTokens;
      }

      return {
        agentId,
        angle: angle.angle,
        success: true,
        retried: true,
        elapsed: totalElapsed,
        usage: mergedUsage,
      };
    } catch (retryErr) {
      const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      logAgent(
        agentId,
        `Retry also FAILED after ${totalElapsed}min: ${retryErr.message.slice(0, 100)}`
      );
      await writeFile(
        logPath,
        `ATTEMPT 1 ERROR: ${firstErr.message}\n\nATTEMPT 2 ERROR: ${retryErr.message}`,
        "utf-8"
      );

      // Sum up costs from both failures
      const failedUsage = {
        costUsd:
          (firstErr.usage?.costUsd ?? 0) + (retryErr.usage?.costUsd ?? 0),
        inputTokens:
          (firstErr.usage?.inputTokens ?? 0) +
          (retryErr.usage?.inputTokens ?? 0),
        outputTokens:
          (firstErr.usage?.outputTokens ?? 0) +
          (retryErr.usage?.outputTokens ?? 0),
        numTurns: 0,
        durationMs: Date.now() - startTime,
      };

      return {
        agentId,
        angle: angle.angle,
        success: false,
        elapsed: totalElapsed,
        usage: failedUsage,
      };
    }
  }
}

// --- Phase 3: Synthesize (aware of failures) ---

async function synthesize(topic, outputDir, results) {
  log("Synthesizing findings from all agents...");

  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  const findingsPaths = [];
  for (const r of succeeded) {
    const p = join(outputDir, `agent-${r.agentId}`, "findings.md");
    if (await fileExists(p)) {
      findingsPaths.push(p);
    }
  }

  if (findingsPaths.length === 0) {
    log("No findings to synthesize — all agents failed.");
    return { reportPath: null, usage: null };
  }

  const pathsList = findingsPaths.map((p) => `- ${p}`).join("\n");
  const failureNote =
    failed.length > 0
      ? `\n\nNOTE: ${failed.length} agent(s) failed and their findings are missing. The failed angles were: ${failed.map((f) => `"${f.angle}"`).join(", ")}. Acknowledge these gaps in your report.`
      : "";

  const reportPath = join(outputDir, "report.md");
  const date = new Date().toISOString().slice(0, 10);

  const template = await loadTemplate("synthesizer.md");
  const prompt =
    fillTemplate(template, {
      TOPIC: topic,
      FINDINGS_PATHS: pathsList,
      OUTPUT_PATH: reportPath,
      DATE: date,
      NUM_AGENTS: String(results.length),
    }) + failureNote;

  const startTime = Date.now();

  try {
    const { usage } = await runClaude(prompt, {
      maxTurns: 15,
      cwd: outputDir,
    });

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    log(
      `Synthesis complete in ${elapsed}min ($${usage.costUsd.toFixed(4)}) → ${reportPath}`
    );
    return { reportPath, usage };
  } catch (err) {
    log(`Synthesis failed: ${err.message}`);
    return { reportPath: null, usage: err.usage ?? null };
  }
}

// --- Phase 4: Judge ---

async function judgeReport(topic, reportPath, outputDir) {
  log("Judging report quality...");

  const template = await loadTemplate("judge.md");
  const judgePath = join(outputDir, "judge.json");

  const prompt = fillTemplate(template, {
    TOPIC: topic,
    REPORT_PATH: reportPath,
    OUTPUT_PATH: judgePath,
  });

  const startTime = Date.now();

  try {
    const { usage } = await runClaude(prompt, {
      maxTurns: 10,
      cwd: outputDir,
    });

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    log(`Judge complete in ${elapsed}min ($${usage.costUsd.toFixed(4)})`);

    // Read and display scores
    if (await fileExists(judgePath)) {
      const judgeRaw = await readFile(judgePath, "utf-8");
      try {
        const scores = JSON.parse(judgeRaw);
        log("--- QUALITY SCORES ---");
        for (const [dim, val] of Object.entries(scores.scores || scores)) {
          if (typeof val === "number") {
            log(`  ${dim}: ${val}/10`);
          }
        }
        if (scores.overall) {
          log(`  OVERALL: ${scores.overall}/10`);
        }
        if (scores.summary) {
          log(`  Summary: ${scores.summary}`);
        }
        log("---------------------");
        return { scores, usage };
      } catch {
        log(`Judge output not valid JSON, saved raw to ${judgePath}`);
        return { scores: null, usage };
      }
    }

    return { scores: null, usage };
  } catch (err) {
    log(`Judge failed: ${err.message}`);
    return { scores: null, usage: err.usage ?? null };
  }
}

// --- Metrics ---

function buildMetrics({
  topic,
  numAgents,
  maxTurns,
  splitterUsage,
  agentResults,
  synthUsage,
  judgeResult,
  totalDurationMin,
}) {
  const agents = agentResults.map((r) => ({
    id: r.agentId,
    angle: r.angle,
    success: r.success,
    retried: r.retried || false,
    durationMin: parseFloat(r.elapsed),
    costUsd: r.usage?.costUsd ?? 0,
    inputTokens: r.usage?.inputTokens ?? 0,
    outputTokens: r.usage?.outputTokens ?? 0,
    numTurns: r.usage?.numTurns ?? 0,
  }));

  const totalCost =
    (splitterUsage?.costUsd ?? 0) +
    agents.reduce((s, a) => s + a.costUsd, 0) +
    (synthUsage?.costUsd ?? 0) +
    (judgeResult?.usage?.costUsd ?? 0);

  return {
    topic,
    numAgents,
    maxTurns,
    startedAt: new Date().toISOString(),
    totalDurationMin,
    totalCostUsd: parseFloat(totalCost.toFixed(4)),
    splitter: {
      costUsd: splitterUsage?.costUsd ?? 0,
      numTurns: splitterUsage?.numTurns ?? 0,
    },
    agents,
    synthesizer: {
      costUsd: synthUsage?.costUsd ?? 0,
    },
    judge: {
      costUsd: judgeResult?.usage?.costUsd ?? 0,
      scores: judgeResult?.scores ?? null,
    },
    successRate: `${agents.filter((a) => a.success).length}/${agents.length}`,
  };
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
research-orchestrator — Parallel deep research with multiple Claude Code instances

Usage:
  node orchestrate.js "Your research topic" [options]

Options:
  --agents N        Number of parallel research agents (default: ${DEFAULT_NUM_AGENTS})
  --max-turns N     Max turns per agent (default: ${DEFAULT_MAX_TURNS})
  --no-synthesize   Skip synthesis step
  --no-judge        Skip quality judgment step
  --obsidian PATH   Copy final report to Obsidian vault path
  --angles-only     Just split topic into angles and exit
  --output DIR      Custom output directory

Examples:
  node orchestrate.js "autoresearch trend March 2026"
  node orchestrate.js "Rust async runtimes comparison" --agents 5
  node orchestrate.js "ZK proof systems 2026" --obsidian ~/Documents/Obsidian\\ Vault/00_Inbox/
  node orchestrate.js "topic" --no-judge  # skip quality scoring
`);
    process.exit(0);
  }

  // Parse args
  const topic = args[0];
  let numAgents = DEFAULT_NUM_AGENTS;
  let maxTurns = DEFAULT_MAX_TURNS;
  let noSynthesize = false;
  let noJudge = false;
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
      case "--no-synthesize":
        noSynthesize = true;
        break;
      case "--no-judge":
        noJudge = true;
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

  const runStartTime = Date.now();
  const outputDir =
    customOutput || join(__dirname, "output", `${timestamp()}-research`);
  await mkdir(outputDir, { recursive: true });

  log(`Research Orchestrator v2`);
  log(`Topic: "${topic}"`);
  log(`Agents: ${numAgents} | Max turns: ${maxTurns}`);
  log(`Output: ${outputDir}`);
  log("---");

  // Save config
  await writeFile(
    join(outputDir, "config.json"),
    JSON.stringify(
      { topic, numAgents, maxTurns, startedAt: new Date().toISOString() },
      null,
      2
    )
  );

  // Phase 1: Split
  const { angles, usage: splitterUsage } = await splitTopic(topic, numAgents);
  await writeFile(
    join(outputDir, "angles.json"),
    JSON.stringify(angles, null, 2)
  );

  log("Research angles:");
  for (const a of angles) {
    log(`  ${a.id}: ${a.angle}`);
  }

  if (anglesOnly) {
    log("Angles-only mode, exiting.");
    process.exit(0);
  }

  log("---");
  log(`Launching ${angles.length} research agents in parallel...`);

  // Phase 2: Parallel research (with retry on failure)
  const agentResults = await Promise.all(
    angles.map((angle) =>
      runResearchAgent(topic, angle, outputDir, maxTurns)
    )
  );

  const succeeded = agentResults.filter((r) => r.success).length;
  const agentCost = agentResults
    .reduce((s, r) => s + (r.usage?.costUsd ?? 0), 0)
    .toFixed(4);

  log("---");
  log(
    `Research phase: ${succeeded}/${agentResults.length} agents succeeded ($${agentCost})`
  );

  for (const r of agentResults) {
    const status = r.success ? (r.retried ? "OK (retried)" : "OK") : "FAIL";
    const cost = r.usage?.costUsd?.toFixed(4) ?? "?";
    log(`  agent-${r.agentId}: ${status} (${r.elapsed}min, $${cost}) — ${r.angle}`);
  }

  // Phase 3: Synthesize
  let synthUsage = null;
  let reportPath = null;

  if (!noSynthesize && succeeded > 0) {
    log("---");
    const synthResult = await synthesize(topic, outputDir, agentResults);
    reportPath = synthResult.reportPath;
    synthUsage = synthResult.usage;

    // Copy to Obsidian if requested
    if (reportPath && obsidianPath) {
      try {
        const report = await readFile(reportPath, "utf-8");
        const obsidianFile = join(
          obsidianPath,
          `Research - ${topic.slice(0, 60)}.md`
        );
        await writeFile(obsidianFile, report);
        log(`Copied report to Obsidian: ${obsidianFile}`);
      } catch (err) {
        log(`Failed to copy to Obsidian: ${err.message}`);
      }
    }
  }

  // Phase 4: Judge
  let judgeResult = { scores: null, usage: null };

  if (!noJudge && reportPath && (await fileExists(reportPath))) {
    log("---");
    judgeResult = await judgeReport(topic, reportPath, outputDir);
  }

  // Save metrics
  const totalDurationMin = parseFloat(
    ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)
  );

  const metrics = buildMetrics({
    topic,
    numAgents,
    maxTurns,
    splitterUsage,
    agentResults,
    synthUsage,
    judgeResult,
    totalDurationMin,
  });

  await writeFile(
    join(outputDir, "metrics.json"),
    JSON.stringify(metrics, null, 2)
  );

  // Final summary
  log("---");
  log("=== RUN COMPLETE ===");
  log(`Topic: "${topic}"`);
  log(`Duration: ${totalDurationMin}min`);
  log(`Cost: $${metrics.totalCostUsd.toFixed(4)}`);
  log(`Agents: ${metrics.successRate} succeeded`);
  if (judgeResult.scores?.overall) {
    log(`Quality: ${judgeResult.scores.overall}/10`);
  }
  log(`Results: ${outputDir}`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
