import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import test from "node:test";

const {
  isLocalTranscriptionReady,
  prependLocalTranscriptionLibraryPath,
  resolveLocalTranscriptionLibraryPath,
  transcribeLocalAudio,
} = await import("./video-transcription-local.ts");

test("local transcription readiness checks the installed model without a subprocess", () => {
  assert.equal(typeof isLocalTranscriptionReady(), "boolean");
});

test("GCC runtime lookup resolves libstdc++ without logging environment secrets", () => {
  const libraryPath = resolveLocalTranscriptionLibraryPath();
  assert.ok(isAbsolute(libraryPath));
  assert.equal(basename(libraryPath), "libstdc++.so.6");
  assert.ok(existsSync(libraryPath));
  assert.equal(
    prependLocalTranscriptionLibraryPath(libraryPath, "/existing/one:/existing/two"),
    `${dirname(libraryPath)}:/existing/one:/existing/two`,
  );

  const previousPath = process.env.PATH;
  const previousSecret = process.env.LOCAL_TRANSCRIPTION_TEST_SECRET;
  const secret = "local-transcription-secret-must-not-appear-in-errors";
  process.env.LOCAL_TRANSCRIPTION_TEST_SECRET = secret;
  process.env.PATH = "";
  try {
    assert.throws(
      resolveLocalTranscriptionLibraryPath,
      (error) => {
        assert.match(error.message, /Could not resolve the native C\+\+ runtime using g\+\+/);
        assert.ok(!error.message.includes(secret));
        return true;
      },
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousSecret === undefined) {
      delete process.env.LOCAL_TRANSCRIPTION_TEST_SECRET;
    } else {
      process.env.LOCAL_TRANSCRIPTION_TEST_SECRET = previousSecret;
    }
  }
});

test("local transcription rejects non-MP3 inputs before attempting model inference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clipwise-local-transcription-"));
  const audioPath = join(directory, "audio.wav");
  try {
    await writeFile(audioPath, Buffer.from("not audio"));
    await assert.rejects(
      transcribeLocalAudio(audioPath),
      /prepared MP3 audio only/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local transcription rejects missing local audio with an explicit error", async () => {
  await assert.rejects(
    transcribeLocalAudio(join(tmpdir(), "clipwise-missing-local-audio.mp3")),
    /prepared local MP3 audio file could not be found/,
  );
});

test("local transcription enforces its bounded timeout option", async () => {
  await assert.rejects(
    transcribeLocalAudio("/tmp/audio.mp3", { timeoutMs: 30 * 60 * 1000 + 1 }),
    /timeout must be between/,
  );
});

test("local transcription kills a timed-out helper process group", async () => {
  const originalDirectory = process.cwd();
  const originalPython = process.env.PYTHON;
  const workspace = await mkdtemp(join(tmpdir(), "clipwise-transcription-timeout-"));
  const helperDirectory = join(workspace, "artifacts", "api-server", "scripts");
  const modelDirectory = join(workspace, ".cache", "clipwise-transcription", "base");
  const python = join(workspace, "fake-python");
  const pidPath = join(workspace, "helper.pid");
  const audioPath = join(workspace, "audio.mp3");
  await Promise.all([
    mkdir(helperDirectory, { recursive: true }),
    mkdir(modelDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(helperDirectory, "transcribe-local.py"), "# fake local helper\n"),
    writeFile(join(modelDirectory, "config.json"), "{}"),
    writeFile(join(modelDirectory, "tokenizer.json"), "{}"),
    writeFile(join(modelDirectory, "vocabulary.txt"), "test vocabulary\n"),
    writeFile(join(modelDirectory, "model.bin"), Buffer.alloc(1024 * 1024)),
    writeFile(audioPath, "prepared local fake MP3"),
    writeFile(
      python,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1_000);",
        "",
      ].join("\n"),
    ),
  ]);
  await chmod(python, 0o755);

  try {
    process.chdir(workspace);
    process.env.PYTHON = python;
    await assert.rejects(
      transcribeLocalAudio(audioPath, { timeoutMs: 4_000 }),
      /Local transcription exceeded its .* minute timeout/,
    );

    const helperPid = Number(await readFile(pidPath, "utf8"));
    assert.ok(Number.isInteger(helperPid) && helperPid > 0);
    assert.throws(
      () => process.kill(helperPid, 0),
      (error) => error?.code === "ESRCH",
    );
  } finally {
    process.chdir(originalDirectory);
    if (originalPython === undefined) delete process.env.PYTHON;
    else process.env.PYTHON = originalPython;
    await rm(workspace, { recursive: true, force: true });
  }
});