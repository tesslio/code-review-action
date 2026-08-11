import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  optionalPositiveIntegerEnv,
  requiredEnv,
  requiredPositiveIntegerEnv,
} from '../src/env.mjs';

test('reads required values and positive integer values', () => {
  const env = { TOKEN: 'secret', PR_NUMBER: '42' };
  assert.equal(requiredEnv('TOKEN', env), 'secret');
  assert.equal(requiredPositiveIntegerEnv('PR_NUMBER', env), 42);
});

test('reads an optional positive integer and treats anything else as absent', () => {
  assert.equal(
    optionalPositiveIntegerEnv('CHECK_RUN_ID', { CHECK_RUN_ID: '7' }),
    7,
  );
  for (const value of ['', '0', '-1', '1.5', 'abc']) {
    assert.equal(
      optionalPositiveIntegerEnv('CHECK_RUN_ID', { CHECK_RUN_ID: value }),
      undefined,
    );
  }
  assert.equal(optionalPositiveIntegerEnv('CHECK_RUN_ID', {}), undefined);
});

test('rejects missing values and invalid pull request numbers', () => {
  assert.throws(() => requiredEnv('TOKEN', {}), /Missing required/);
  for (const value of ['0', '-1', '1.5', 'abc']) {
    assert.throws(
      () => requiredPositiveIntegerEnv('PR_NUMBER', { PR_NUMBER: value }),
      /positive integer/,
    );
  }
});
