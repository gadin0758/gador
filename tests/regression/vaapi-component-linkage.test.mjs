import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENGINE_DIR = path.join(REPO_ROOT, "dist/gador/lib/gador-engine");

test("VA-API Component Build Linkage Gate: libva_stubs must not be duplicated across multiple .so libraries", (t) => {
  if (!fs.existsSync(ENGINE_DIR)) {
    t.skip("dist/gador/lib/gador-engine not built yet");
    return;
  }
  const soFiles = fs
    .readdirSync(ENGINE_DIR)
    .filter((f) => f.endsWith(".so"))
    .map((f) => path.join(ENGINE_DIR, f));

  if (soFiles.length === 0) {
    t.skip("No component .so files in dist/gador/lib/gador-engine");
    return;
  }

  const owners = [];
  for (const soPath of soFiles) {
    let out = "";
    try {
      out = execFileSync("nm", [soPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch {
      continue;
    }
    if (out.includes("vaDestroyBuffer_ptr")) {
      owners.push(path.basename(soPath));
    }
  }

  assert.ok(
    owners.length <= 1,
    `Duplicate static libva_stubs (vaDestroyBuffer_ptr) found in multiple component libraries: ${owners.join(", ")}. ` +
      `This causes NULL function pointer SIGSEGV in AV1VaapiVideoDecoderDelegate::SubmitDecode when PreSandboxInitialization populates a different .so's copy.`
  );
  if (owners.length === 1) {
    assert.equal(owners[0], "libmedia_gpu.so", "libva_stubs must be owned exclusively by libmedia_gpu.so");
  }
});
