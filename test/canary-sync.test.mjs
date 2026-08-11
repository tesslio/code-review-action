import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workflow = await readFile(
  new URL('../.github/workflows/sync-canary.yml', import.meta.url),
  'utf8',
);

test('synchronizes only validated main pushes or explicit dispatches', () => {
  assert.match(workflow, /workflow_run:\n    workflows: \[Validate\]/);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.event == 'push'/);
  assert.match(workflow, /workflow_run\.head_branch == 'main'/);
  assert.match(workflow, /workflow_dispatch:/);
});

test('validates the prospective merge before creating a pull request', () => {
  assert.match(workflow, /ref: canary/);
  assert.match(workflow, /ref: main/);
  assert.equal(
    [...workflow.matchAll(/persist-credentials: false/g)].length,
    2,
  );
  assert.match(
    workflow,
    /git fetch --no-tags "\$GITHUB_WORKSPACE\/validated-main"/,
  );
  assert.match(workflow, /git merge --no-commit --no-ff "\$main_sha"/);
  const validation = workflow.indexOf('bash scripts/validate-foundation.sh');
  const creation = workflow.indexOf('gh pr create');
  assert.ok(validation > -1 && validation < creation);
});

test('does not expose a write token while executing canary code', () => {
  assert.match(workflow, /permissions:\n  contents: read/);
  const validateJob = workflow.slice(
    workflow.indexOf('  validate:'),
    workflow.indexOf('\n  sync:'),
  );
  assert.doesNotMatch(validateJob, /contents: write|pull-requests: write/);

  const syncJob = workflow.slice(workflow.indexOf('  sync:'));
  assert.match(syncJob, /needs: validate/);
  assert.match(syncJob, /contents: write\n      pull-requests: write/);
  assert.doesNotMatch(syncJob, /actions\/checkout|validate-foundation/);
});

test('merges through an auditable pull request without rewriting canary', () => {
  assert.match(workflow, /--base canary/);
  assert.match(workflow, /--head main/);
  assert.match(workflow, /--match-head-commit "\$MAIN_SHA"/);
  assert.doesNotMatch(workflow, /push --force|reset --hard/);
});
