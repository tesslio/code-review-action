import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const action = await readFile(new URL('../action.yml', import.meta.url), 'utf8');
const contract = await readFile(
  new URL('../docs/action-contract.md', import.meta.url),
  'utf8',
);
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

test('exposes one product-level Action contract', () => {
  const inputBlock = action.slice(
    action.indexOf('inputs:'),
    action.indexOf('\noutputs:'),
  );
  const names = [...inputBlock.matchAll(/^  ([a-z0-9-]+):$/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(names, [
    'tessl-token',
    'profile',
    'model',
    'effort',
    'lenses',
    'mode',
    'pr-number',
    'cli-channel',
  ]);
});

test('pins third-party Actions by full commit SHA', () => {
  const references = [...action.matchAll(/^\s+uses:\s+([^\s]+)/gm)].map(
    (match) => match[1],
  );
  assert.ok(references.length > 0);
  for (const reference of references) {
    assert.match(reference, /@[0-9a-f]{40}$/);
  }
});

test('checks out the reviewed head without persisted credentials', () => {
  assert.match(
    action,
    /ref: \$\{\{ steps\.pr\.outputs\['head-sha'\] \}\}/,
  );
  assert.match(action, /path: \.tessl-code-review\/workspace/);
  assert.match(
    action,
    /working-directory: \$\{\{ github\.workspace \}\}\/\.tessl-code-review\/workspace/,
  );
  assert.doesNotMatch(action, /path: \$\{\{ runner\.temp \}\}/);
  assert.match(action, /persist-credentials: false/);
  assert.match(action, /version: 0\.96\.0/);
  assert.doesNotMatch(action, /version: latest/);
});

test('reports a check run on the reviewed head and concludes it at finalize', () => {
  const start = action.indexOf('src/start-check-run.mjs');
  assert.ok(start > action.indexOf('src/resolve-pull-request.mjs'));
  assert.ok(start < action.indexOf('src/run-review.sh'));
  assert.ok(start < action.indexOf('src/finalize.mjs'));
  assert.match(
    action,
    /CHECK_RUN_ID: \$\{\{ steps\.check\.outputs\['check-run-id'\] \}\}/,
  );
});

test('runs trusted support from the pinned Action path', () => {
  assert.match(action, /GITHUB_ACTION_PATH/);
});

test('uploads only the sanitized public artifact', () => {
  assert.match(action, /build-public-artifact\.mjs/);
  assert.match(
    action,
    /path: \$\{\{ steps\.review\.outputs\['artifact-path'\] \}\}/,
  );
  assert.doesNotMatch(
    action,
    /path:\s*\|[\s\S]*steps\.review\.outputs\['result-path'\]/,
  );
});

test('uses bracket lookup for every hyphenated output in expressions', () => {
  assert.doesNotMatch(action, /outputs\.[a-z][a-z0-9]*-[a-z0-9-]+/i);
  assert.doesNotMatch(action, /inputs\.[a-z][a-z0-9]*-[a-z0-9-]+/i);
});

test('documents approval as the public success status', () => {
  assert.match(contract, /\| `approved` \| success \| success \|/);
  assert.match(contract, /outcome uses `approved`/);
  assert.match(contract, /`requiresChanges`/);
});

test('documents the fail-closed gate and the superseded outcome', () => {
  assert.match(contract, /\| `gate-verdict-failure` \| failure \|/);
  assert.match(contract, /Gate mode fails closed/);
  assert.match(contract, /## Superseded runs/);
  assert.match(readme, /### Superseded runs/);
});

test('documents the artifact field allowlist it enforces', () => {
  assert.match(contract, /## Public artifact schema/);
  assert.match(contract, /`outcome.findings\[\].location`/);
});

test('shows a copyable workflow for each supported trigger', () => {
  assert.match(readme, /on:\n  issue_comment:\n    types: \[created\]/);
  assert.match(readme, /author_association/);
  assert.match(readme, /types: \[opened, reopened, ready_for_review, synchronize\]/);
  assert.match(readme, /cancel-in-progress: true/);
  const references = [
    ...readme.matchAll(/uses: tesslio\/code-review-action@(\S+)/g),
  ];
  assert.equal(references.length, 5);
  for (const reference of references) {
    assert.equal(reference[1], '<full-commit-sha>');
  }
  // The review plugin is referenced as `tessl/code-review`, which is not an
  // Action reference and must never appear in a `uses:` example.
  assert.doesNotMatch(readme, /uses: tesslio\/code-review@/);
});
