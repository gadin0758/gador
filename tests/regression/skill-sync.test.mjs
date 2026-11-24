import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

test("Skill-First Gate: SKILL.md stays 100% synchronized with clients/protocol/schema.json", () => {
  const schemaPath = path.join(REPO_ROOT, "clients/protocol/schema.json");
  const skillPath = path.join(REPO_ROOT, "clients/skills/gador/SKILL.md");

  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const skillMd = fs.readFileSync(skillPath, "utf8");

  // Every protocol method must be documented in SKILL.md
  for (const method of Object.keys(schema.methods)) {
    assert.ok(
      skillMd.includes(method),
      `Protocol method "${method}" is missing from clients/skills/gador/SKILL.md`
    );
  }

  // Every error code must be documented in SKILL.md
  for (const code of schema.errorCodes) {
    assert.ok(
      skillMd.includes(code),
      `Error code "${code}" is missing from clients/skills/gador/SKILL.md`
    );
  }

  // Every AuthMode, ControlState, RouteMode, and DialogType value must be documented
  for (const [enumName, values] of Object.entries(schema.enums)) {
    for (const val of values) {
      assert.ok(
        skillMd.includes(val),
        `Enum value ${enumName}."${val}" is missing from clients/skills/gador/SKILL.md`
      );
    }
  }
});
