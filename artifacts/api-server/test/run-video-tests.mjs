import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const directory = await mkdtemp(join(tmpdir(), 'clipwise-regressions-'));
try {
  const files = ['src/lib/video-ingest.test.mjs', 'src/lib/video-pipeline.test.mjs', 'src/lib/video-transcription-local.test.mjs'];
  const outputFiles = [];
  for (const [index, file] of files.entries()) {
    const outfile = join(directory, `test-${index}.mjs`);
    await build({
      entryPoints: [file], outfile, bundle: true, platform: 'node', format: 'esm',
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    });
    outputFiles.push(outfile);
  }
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', ...outputFiles], {
      stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' },
    });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}