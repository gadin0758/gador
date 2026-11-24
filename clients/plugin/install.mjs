#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const SKILL_SRC = path.join(REPO_ROOT, "clients/skills/gador");
const MCP_ENTRY = path.join(REPO_ROOT, "clients/mcp-server/index.mjs");
const CLI_ENTRY = path.join(REPO_ROOT, "clients/cli/gador-ctl.mjs");

const KNOWN_SKILL_TARGETS = {
  claude: path.join(os.homedir(), ".claude", "skills", "gador"),
  codex: path.join(os.homedir(), ".codex", "skills", "gador"),
  agents: path.join(os.homedir(), ".agents", "skills", "gador"),
  opencode: path.join(os.homedir(), ".config", "opencode", "skills", "gador"),
  antigravity: path.join(os.homedir(), ".gemini", "config", "skills", "gador"),
};

function parseArgs(argv) {
  const opts = { targets: [], dryRun: false, printMcp: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--print-mcp") {
      opts.printMcp = true;
    } else if (arg === "--target" && argv[i + 1]) {
      opts.targets.push(argv[++i]);
    } else if (arg === "--all") {
      opts.targets.push(...Object.keys(KNOWN_SKILL_TARGETS));
    }
  }
  if (opts.targets.length === 0) {
    opts.targets.push("agents", "claude");
  }
  return opts;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mcpConfig = {
    mcpServers: {
      gador: {
        command: "node",
        args: [MCP_ENTRY],
      },
    },
  };

  if (opts.printMcp) {
    process.stdout.write(JSON.stringify(mcpConfig, null, 2) + "\n");
    return;
  }

  const installed = [];
  for (const targetKey of new Set(opts.targets)) {
    const dest = KNOWN_SKILL_TARGETS[targetKey] || path.resolve(targetKey);
    if (!opts.dryRun) {
      copyDirRecursive(SKILL_SRC, dest);
    }
    installed.push({ target: targetKey, path: dest, dryRun: opts.dryRun });
  }

  process.stdout.write(
    JSON.stringify(
      {
        installedSkills: installed,
        cliEntry: CLI_ENTRY,
        mcpConfig,
      },
      null,
      2
    ) + "\n"
  );
}

main();
