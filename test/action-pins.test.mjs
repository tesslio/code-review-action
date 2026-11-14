import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const validation = readFileSync(new URL('../scripts/validate-foundation.sh', import.meta.url), 'utf8');
const pinCheck = validation.slice(validation.indexOf('# A reference'), validation.indexOf('node --test'));

function check(reference) {
  const dir = mkdtempSync(join(tmpdir(), 'action-pins-'));
  try {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, 'action.yml'), `steps:\n  - uses: ${reference}\n`);
    // The checker reads the same paths as the foundation script.
    const result = spawnSync('bash', ['-c', pinCheck], { cwd: dir, encoding: 'utf8' });
    assert.ifError(result.error);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const reference of ['owner/action@release-candidate', 'owner/action@abc1234', 'owner/action@v2-beta', '"owner/action@feature" # mutable']) {
  test(`foundation rejects a non-SHA third-party reference: ${reference}`, () => {
    assert.equal(check(reference).status, 1);
  });
}

for (const reference of [
  'owner/action@' + 'a'.repeat(40),
  '"owner/action@' + 'A'.repeat(40) + '" # immutable',
  'docker://example/image@sha256:' + 'a'.repeat(64),
  "'tesslio/code-review-action@v1' # own major tag",
  './local-action',
]) {
  test(`foundation accepts an allowed reference: ${reference}`, () => {
    assert.equal(check(reference).status, 0);
  });
}
