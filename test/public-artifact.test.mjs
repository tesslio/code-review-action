import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildPublicArtifact,
  writePublicArtifact,
} from '../src/public-artifact.mjs';

async function writeArtifactFrom(resultContents) {
  const directory = await mkdtemp(join(tmpdir(), 'code-review-action-test-'));
  const resultPath = join(directory, 'result.json');
  const artifactPath = join(directory, 'public-result.json');
  if (resultContents !== undefined) {
    await writeFile(resultPath, resultContents, 'utf8');
  }

  try {
    const artifact = await writePublicArtifact({ resultPath, artifactPath });
    return {
      artifact,
      written: JSON.parse(await readFile(artifactPath, 'utf8')),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('builds artifacts from an explicit field allowlist', () => {
  const artifact = buildPublicArtifact({
    result: {
      status: 'ok',
      outcome: {
        schemaVersion: 1,
        runId: 'run-1',
        profileName: 'standard',
        model: 'model-1',
        effort: 'high',
        subject: { change: { headRevision: 'head' } },
        judgement: 'Looks good.',
        approved: true,
        findings: [
          {
            id: 'finding-1',
            title: 'Optional cleanup',
            requiresChanges: false,
          },
        ],
        reconciliation: [],
      },
      diagnostics: { durationMs: 123, extraMetrics: { value: 900 } },
      unpublishedField: 'not-for-artifact',
      publication: { schemaVersion: 1, status: 'published', reviewId: 7 },
    },
    requestedLenses: '["tessl/code-review#review-security"]',
  });

  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.diagnostics.durationMs, 123);
  assert.deepEqual(artifact.configuration, {
    profile: 'standard',
    model: 'model-1',
    effort: 'high',
    lenses: ['tessl/code-review#review-security'],
  });
  assert.equal(artifact.publication.reviewId, 7);
  assert.equal(artifact.outcome.approved, true);
  assert.equal(artifact.outcome.findings[0].requiresChanges, false);
  const json = JSON.stringify(artifact);
  assert.doesNotMatch(json, /extraMetrics|unpublishedField|not-for-artifact/);
});

test('publishes each configured lens with its effort', () => {
  const artifact = buildPublicArtifact({
    result: {
      status: 'ok',
      outcome: {
        schemaVersion: 1,
        lenses: [
          { ref: 'tessl/code-review#review-security' },
          {
            ref: './tiles/brand/SKILL.md',
            effort: 'low',
            globs: ['**/*.md'],
            resolutionRef: 'internal',
          },
        ],
      },
    },
  });

  assert.deepEqual(artifact.outcome.lenses, [
    { ref: 'tessl/code-review#review-security' },
    { ref: './tiles/brand/SKILL.md', effort: 'low' },
  ]);
  // A lens entry is projected, not copied: a field the CLI adds to one later
  // stays out of the artifact until it is allowlisted.
  const json = JSON.stringify(artifact);
  assert.doesNotMatch(json, /globs|resolutionRef|internal/);
});

test('drops a malformed lens entry rather than serializing it', () => {
  const artifact = buildPublicArtifact({
    result: {
      status: 'ok',
      outcome: {
        schemaVersion: 1,
        lenses: [
          { ref: 'tessl/code-review#review-security', effort: 'high' },
          // No ref to identify it by, so there is nothing publishable.
          { effort: 'high' },
          // A nested value where a scalar belongs: dropped whole, so the
          // structure cannot reach the artifact through either field.
          { ref: { nested: 'not-a-ref' } },
          { ref: './tiles/brand/SKILL.md', effort: { nested: 'not-an-effort' } },
        ],
      },
    },
  });

  assert.deepEqual(artifact.outcome.lenses, [
    { ref: 'tessl/code-review#review-security', effort: 'high' },
    { ref: './tiles/brand/SKILL.md' },
  ]);
  assert.doesNotMatch(JSON.stringify(artifact), /nested|not-a-ref|not-an-effort/);
});

test('omits lenses entirely for a CLI that does not report them', () => {
  const artifact = buildPublicArtifact({
    result: {
      status: 'ok',
      outcome: { schemaVersion: 1, runId: 'run-1', approved: true },
    },
  });

  // Absent rather than an empty array, so a consumer can tell "not reported"
  // from "resolved no lenses".
  assert.ok(!('lenses' in artifact.outcome));
});

test('distinguishes a run that resolved no lenses from one that reported none', () => {
  const artifact = buildPublicArtifact({
    result: { status: 'ok', outcome: { schemaVersion: 1, lenses: [] } },
  });

  assert.deepEqual(artifact.outcome.lenses, []);
});

test('drops an unexpected field from the outcome and the failure', () => {
  const artifact = buildPublicArtifact({
    result: {
      status: 'ok',
      outcome: {
        runId: 'run-1',
        approved: false,
        promptText: 'do-not-publish',
        subject: {
          repository: 'https://github.com/acme/widgets.git',
          change: { headRevision: 'head', diff: 'do-not-publish' },
        },
        findings: [
          {
            id: 'finding-1',
            title: 'Validate the input',
            body: 'The value is used before validation.',
            severity: 'major',
            requiresChanges: true,
            disposition: 'new',
            lensRefs: ['tessl/code-review#review-security'],
            location: { path: 'a.ts', line: 2, side: 'RIGHT', snippet: 'do-not-publish' },
            evidence: ['do-not-publish'],
          },
        ],
        reconciliation: [
          {
            category: 'addressed',
            priorFindingId: 'prior-1',
            transcript: 'do-not-publish',
          },
        ],
      },
      failure: { kind: 'review-failed', message: 'Review failed.', stack: 'do-not-publish' },
    },
  });

  assert.doesNotMatch(JSON.stringify(artifact), /do-not-publish/);
  assert.deepEqual(artifact.outcome.findings[0], {
    id: 'finding-1',
    title: 'Validate the input',
    body: 'The value is used before validation.',
    severity: 'major',
    requiresChanges: true,
    disposition: 'new',
    lensRefs: ['tessl/code-review#review-security'],
    location: { path: 'a.ts', line: 2, side: 'RIGHT' },
  });
  assert.deepEqual(artifact.outcome.subject, {
    repository: 'https://github.com/acme/widgets.git',
    change: { headRevision: 'head' },
  });
  assert.deepEqual(artifact.outcome.reconciliation, [
    { category: 'addressed', priorFindingId: 'prior-1' },
  ]);
  assert.deepEqual(artifact.failure, {
    kind: 'review-failed',
    message: 'Review failed.',
  });
});

test('publishes a finding that carries its location flat on the finding', () => {
  const artifact = buildPublicArtifact({
    result: {
      status: 'ok',
      outcome: {
        runId: 'run-1',
        approved: false,
        findings: [
          {
            id: 'finding-1',
            title: 'Validate the input',
            requiresChanges: true,
            path: 'a.ts',
            line: 2,
            side: 'RIGHT',
            reason: 'The line is outside the reviewed diff.',
            evidence: ['do-not-publish'],
          },
        ],
      },
    },
  });

  assert.deepEqual(artifact.outcome.findings[0], {
    id: 'finding-1',
    title: 'Validate the input',
    requiresChanges: true,
    path: 'a.ts',
    line: 2,
    side: 'RIGHT',
    reason: 'The line is outside the reviewed diff.',
  });
});

test('records a structured CLI failure without requiring publication', () => {
  const artifact = buildPublicArtifact({
    result: {
      status: 'failed',
      failure: { kind: 'review-failed', message: 'Review failed.' },
      diagnostics: { durationMs: 50 },
    },
  });

  assert.equal(artifact.status, 'failed');
  assert.deepEqual(artifact.failure, {
    kind: 'review-failed',
    message: 'Review failed.',
  });
  assert.equal(artifact.publication, null);
});

test('retains a safe no-match result and only requested configuration', () => {
  const artifact = buildPublicArtifact({
    result: {
      status: 'skipped',
      reason: 'no-matching-lenses',
      diagnostics: { durationMs: 18, sourceDiff: 'do-not-publish' },
      configuration: {
        profile: { lenses: [{ globs: ['apps/secret-service/**'] }] },
        model: 'cli-model',
        prompt: 'do-not-publish',
      },
    },
    requestedConfiguration: {
      profile: 'requested-profile',
      model: 'requested-model',
      effort: 'high',
    },
    requestedLenses: '["apps/backend/**"]',
  });

  assert.deepEqual(artifact, {
    schemaVersion: 1,
    status: 'skipped',
    reason: 'no-matching-lenses',
    diagnostics: { durationMs: 18 },
    configuration: {
      profile: 'requested-profile',
      model: 'requested-model',
      effort: 'high',
      lenses: ['apps/backend/**'],
    },
    publication: null,
  });
  assert.doesNotMatch(JSON.stringify(artifact), /do-not-publish/);
  assert.doesNotMatch(JSON.stringify(artifact), /secret-service|cli-model/);
});

test('drops malformed diagnostics and empty requested overrides', () => {
  const artifact = buildPublicArtifact({
    result: {
      status: 'skipped',
      reason: 'no-matching-lenses',
      diagnostics: { durationMs: { nested: 'do-not-publish' } },
    },
    requestedConfiguration: {
      profile: 'standard',
      model: '',
      effort: '',
    },
  });

  assert.deepEqual(artifact.diagnostics, {});
  assert.deepEqual(artifact.configuration, { profile: 'standard' });
  assert.doesNotMatch(JSON.stringify(artifact), /do-not-publish/);
});

test('publishes the no-match reason only for the complete skipped discriminator', () => {
  const artifact = buildPublicArtifact({
    result: { status: 'failed', reason: 'no-matching-lenses' },
  });

  assert.equal(artifact.status, 'failed');
  assert.equal(Object.hasOwn(artifact, 'reason'), false);
});

test('records a failure when the result file is missing', async () => {
  const { written } = await writeArtifactFrom(undefined);

  assert.equal(written.status, 'failed');
  assert.equal(written.publication, null);
});

test('records a failure when the result file is empty', async () => {
  const { written } = await writeArtifactFrom('');

  assert.equal(written.status, 'failed');
  assert.equal(written.publication, null);
});

test('records a failure when the result file holds only whitespace', async () => {
  const { written } = await writeArtifactFrom('  \n\t\n');

  assert.equal(written.status, 'failed');
  assert.equal(written.publication, null);
});

test('records the reported status when the result file holds JSON', async () => {
  const { written } = await writeArtifactFrom(
    JSON.stringify({ status: 'ok', diagnostics: { durationMs: 42 } }),
  );

  assert.equal(written.status, 'ok');
  assert.equal(written.diagnostics.durationMs, 42);
});
