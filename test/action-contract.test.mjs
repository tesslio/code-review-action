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
    'cli-version',
    'cli-channel',
  ]);
});

test('rejects an effort outside the values it advertises', () => {
  const step = action.slice(
    action.indexOf('name: Validate Action inputs'),
    action.indexOf('name: Resolve pull request'),
  );
  assert.match(step, /EFFORT: \$\{\{ inputs\.effort \}\}/);
  // Empty stays legal: it is how a caller defers to the profile and the CLI.
  assert.match(step, /-z "\$EFFORT"/);
  for (const value of ['low', 'medium', 'high']) {
    assert.match(step, new RegExp(`"\\$EFFORT" == "${value}"`));
  }
  // Advertised as supported configuration, so it belongs in the Inputs table
  // rather than only in the action metadata.
  assert.match(contract, /^\| `effort` \| no \|/m);
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
});

test('the caller chooses the CLI version, and a mismatch is detected', () => {
  // The CLI is no longer pinned by this Action, so improvements reach callers
  // without an Action release. What replaces the pin is detection: an installed
  // CLI that cannot publish has to fail by name, before the review runs, rather
  // than deep in argument parsing.
  assert.match(action, /version: \$\{\{ inputs\['cli-version'\] \}\}/);
  const preflight = action.indexOf('Check the installed CLI can publish');
  assert.ok(preflight > action.indexOf('tesslio/setup-tessl'));
  assert.ok(preflight < action.indexOf('src/run-review.sh'));
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

test('publishes a failure notice only when the review itself failed', () => {
  // The CLI reviews and publishes in one invocation, so its exit code is the
  // only signal here; a no-match result exits zero and leaves no notice.
  assert.match(
    action,
    /if: always\(\) && steps\.review\.outputs\['exit-code'\] != '0'/,
  );
  assert.match(contract, /`skipped-no-matching-lenses`/);
  assert.match(contract, /`no-matching-lenses`/);
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
  assert.match(contract, /`outcome.lenses\[\]`/);
  // The configured-not-dispatched semantic is the sentence a consumer builds
  // on, so it is part of the contract rather than incidental prose.
  assert.match(contract, /membership is not evidence the lens ran/);
});

test('documents the result marker a consumer is entitled to rely on', () => {
  assert.match(contract, /## Comment protocol/);
  // The Action publishes no model-authored text, so it carries no AI-system
  // notice of its own; the CLI stamps one on the review it publishes.
  assert.doesNotMatch(contract, /ai-notice:v1` is a supported marker/);
  // The documented example must be the grammar the Action emits: bare
  // space-separated key=value, nothing quoted.
  const example = contract.match(
    /<!-- tessl-code-review:result:v1 [^\n]*-->/,
  )?.[0];
  assert.ok(example, 'the contract must show the marker it promises');
  assert.doesNotMatch(example, /"/);
  // The CLI emits this marker, so the binding that used to tie this example to
  // the emitter now lives beside it there. What stays checkable here is that
  // the documented example is well formed and names the fields it promises.
  assert.match(
    example,
    /^<!-- tessl-code-review:result:v1( [a-z][a-z0-9-]*=[^\s>]+)+ -->$/,
  );
  const documented = [...example.matchAll(/([a-z][a-z0-9-]*)=([^\s>]+)/g)].map(
    ([, field]) => field,
  );
  assert.deepEqual(documented, [
    'approved',
    'findings-total',
    'findings-unplaced',
  ]);
  // The internal markers stay internal: naming them as unsupported is what lets
  // them change.
  for (const marker of [
    'run:v1',
    'workflow-run:v1',
    'failure:v1',
    'lenses:v1',
    'finding:v1',
    'reconciliation:v1',
  ]) {
    assert.ok(
      contract.includes(`\`${marker}\``),
      `the contract must classify ${marker}`,
    );
  }
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
