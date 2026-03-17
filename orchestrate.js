#!/usr/bin/env node

import { spawn } from "child_process";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "templates");

// --- Config ---
const DEFAULT_NUM_AGENTS = 3;
const DEFAULT_MAX_TURNS = 30;
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

function runClaude(prompt, { maxTurns, cwd }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--dangerously-skip-permissions",
      "--max-turns",
      String(maxTurns),
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
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(`Claude exited with code ${code}\nstderr: ${stderr}`)
        );
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

  const result = await runClaude(prompt, {
    maxTurns: 5,
    cwd: __dirname,
  });

  // Extract JSON from the response — handle markdown fences
  let jsonStr = result;
  const fenceMatch = result.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1];
  }

  // Try to find a JSON array in the output
  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    jsonStr = arrayMatch[0];
  }

  try {
    const angles = JSON.parse(jsonStr);
    log(`Got ${angles.length} research angles`);
    return angles;
  } catch (e) {
    // Fallback: generate generic angles
    log(`Failed to parse splitter output, using generic angles`);
    log(`Raw output: ${result.slice(0, 500)}`);
    return Array.from({ length: numAgents }, (_, i) => ({
      id: i,
      angle: `Research angle ${i + 1}`,
      description: `Research aspect ${i + 1} of: ${topic}`,
      search_queries: [topic],
    }));
  }
}

// --- Phase 2: Run parallel research agents ---

async function runResearchAgent(topic, angle, outputDir, maxTurns) {
  const agentId = angle.id;
  const outputPath = join(outputDir, `agent-${agentId}`, "findings.md");
  const logPath = join(outputDir, `agent-${agentId}`, "log.txt");

  await mkdir(join(outputDir, `agent-${agentId}`), { recursive: true });

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

  try {
    const result = await runClaude(prompt, {
      maxTurns,
      cwd: join(outputDir, `agent-${agentId}`),
    });

    await writeFile(logPath, result, "utf-8");

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    logAgent(agentId, `Done in ${elapsed}min: "${angle.angle}"`);

    return { agentId, angle: angle.angle, success: true, elapsed };
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    logAgent(agentId, `FAILED after ${elapsed}min: ${err.message}`);
    await writeFile(logPath, `ERROR: ${err.message}`, "utf-8");
    return { agentId, angle: angle.angle, success: false, elapsed };
  }
}

// --- Phase 3: Synthesize ---

async function synthesize(topic, outputDir, numAgents) {
  log("Synthesizing findings from all agents...");

  const findingsPaths = Array.from(
    { length: numAgents },
    (_, i) => join(outputDir, `agent-${i}`, "findings.md")
  );

  const pathsList = findingsPaths
    .map((p) => `- ${p}`)
    .join("\n");

  const reportPath = join(outputDir, "report.md");
  const date = new Date().toISOString().slice(0, 10);

  const template = await loadTemplate("synthesizer.md");
  const prompt = fillTemplate(template, {
    TOPIC: topic,
    FINDINGS_PATHS: pathsList,
    OUTPUT_PATH: reportPath,
    DATE: date,
    NUM_AGENTS: String(numAgents),
  });

  try {
    await runClaude(prompt, {
      maxTurns: 15,
      cwd: outputDir,
    });

    log(`Synthesis complete → ${reportPath}`);
    return reportPath;
  } catch (err) {
    log(`Synthesis failed: ${err.message}`);
    return null;
  }
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
  --obsidian PATH   Copy final report to Obsidian vault path
  --angles-only     Just split topic into angles and exit
  --output DIR      Custom output directory

Examples:
  node orchestrate.js "autoresearch trend March 2026"
  node orchestrate.js "Rust async runtimes comparison" --agents 5
  node orchestrate.js "ZK proof systems 2026" --obsidian ~/Documents/Obsidian\\ Vault/00_Inbox/
`);
    process.exit(0);
  }

  // Parse args
  const topic = args[0];
  let numAgents = DEFAULT_NUM_AGENTS;
  let maxTurns = DEFAULT_MAX_TURNS;
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

  const outputDir =
    customOutput || join(__dirname, "output", `${timestamp()}-research`);
  await mkdir(outputDir, { recursive: true });

  log(`Research Orchestrator`);
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
  const angles = await splitTopic(topic, numAgents);
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
  const startTime = Date.now();

  // Phase 2: Parallel research
  const results = await Promise.all(
    angles.map((angle) =>
      runResearchAgent(topic, angle, outputDir, maxTurns)
    )
  );

  const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const succeeded = results.filter((r) => r.success).length;

  log("---");
  log(`Research phase complete: ${succeeded}/${results.length} agents succeeded in ${totalElapsed}min`);

  for (const r of results) {
    log(
      `  agent-${r.agentId}: ${r.success ? "OK" : "FAIL"} (${r.elapsed}min) — ${r.angle}`
    );
  }

  // Phase 3: Synthesize
  if (!noSynthesize && succeeded > 0) {
    log("---");
    const reportPath = await synthesize(topic, outputDir, angles.length);

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

  log("---");
  log("Done.");
  log(`Results: ${outputDir}`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
