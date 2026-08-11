import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = new URL('../src/start-check-run.mjs', import.meta.url).pathname;
const stub = new URL('./stub-github-fetch.mjs', import.meta.url).pathname;

async function startCheckRun({ writableOutputs = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'code-review-action-test-'));
  const outputs = join(directory, 'outputs');
  const requests = join(directory, 'requests');
  await writeFile(outputs, '');
  await writeFile(requests, '');

  try {
    const completed = await run(process.execPath, ['--import', stub, script], {
      env: {
        PATH: process.env.PATH,
        GH_TOKEN: 'token',
        REPOSITORY: 'acme/widgets',
        MODE: 'gate',
        HEAD_SHA: 'a'.repeat(40),
        RUN_URL: 'https://github.example/run/1',
        GITHUB_OUTPUT: writableOutputs
          ? outputs
          : join(directory, 'absent', 'outputs'),
        REQUEST_LOG: requests,
      },
    }).catch((error) => error);
    return {
      exitCode: completed.code ?? 0,
      outputs: await readFile(outputs, 'utf8'),
      requests: (await readFile(requests, 'utf8')).trim(),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('hands the created check-run identifier to the later steps', async () => {
  const { exitCode, outputs, requests } = await startCheckRun();

  assert.equal(exitCode, 0);
  assert.match(outputs, /check-run-id=987654/);
  assert.match(requests, /POST .*\/check-runs/);
});

test('concludes the created check run when the identifier cannot be written', async () => {
  const { exitCode, requests } = await startCheckRun({
    writableOutputs: false,
  });

  assert.notEqual(exitCode, 0);
  assert.match(requests, /PATCH .*\/check-runs\/987654/);
  assert.match(requests, /"conclusion":"failure"/);
});
