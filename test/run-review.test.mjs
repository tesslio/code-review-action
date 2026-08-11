import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const script = new URL('../src/run-review.sh', import.meta.url).pathname;

async function capturedArguments({ model = '', effort = '', lenses = '' }) {
  const directory = await mkdtemp(join(tmpdir(), 'code-review-action-test-'));
  const executable = join(directory, 'tessl');
  const capture = join(directory, 'arguments');
  const outputs = join(directory, 'outputs');
  await writeFile(
    executable,
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$CAPTURE_PATH"\nprintf \'{"status":"ok"}\\n\'\n',
  );
  await chmod(executable, 0o755);

  try {
    await run('bash', [script], {
      env: {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH}`,
        CAPTURE_PATH: capture,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: outputs,
        HEAD_SHA: 'a'.repeat(40),
        PR_NUMBER: '42',
        PROFILE: 'standard',
        MODEL: model,
        EFFORT: effort,
        LENSES: lenses,
      },
    });
    return (await readFile(capture, 'utf8')).trim().split('\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('leaves model and effort unset so the profile supplies them', async () => {
  assert.deepEqual(await capturedArguments({}), [
    'code',
    'review',
    '--pr',
    '42',
    '--profile',
    'standard',
    '--json',
  ]);
});

test('forwards supplied model and effort overrides', async () => {
  assert.deepEqual(
    await capturedArguments({ model: 'model-1', effort: 'high' }),
    [
      'code',
      'review',
      '--pr',
      '42',
      '--profile',
      'standard',
      '--model',
      'model-1',
      '--effort',
      'high',
      '--json',
    ],
  );
});
