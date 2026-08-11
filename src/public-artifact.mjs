import { readFile, writeFile } from 'node:fs/promises';

function selectedLenses(requestedLenses) {
  if (!requestedLenses) return undefined;
  const parsed = JSON.parse(requestedLenses);
  if (!Array.isArray(parsed) || parsed.some((lens) => typeof lens !== 'string')) {
    throw new Error('Requested lenses must be a JSON array of strings.');
  }
  return parsed;
}

// The published fields, named one by one. A field the CLI adds later is dropped
// until it is added here and to the documented artifact schema, so no new CLI
// output reaches the artifact without that decision being made. Finding evidence
// is excluded because it can quote reviewed source.
const OUTCOME_FIELDS = [
  'schemaVersion',
  'runId',
  'profileName',
  'model',
  'effort',
  'judgement',
  'approved',
];
const SUBJECT_FIELDS = ['schemaVersion', 'repository'];
const CHANGE_FIELDS = ['baseRevision', 'headRevision', 'headKind'];
// A finding carries its location either nested under `location` or flat on the
// finding itself, and both forms are published so that neither loses it.
const FINDING_FIELDS = [
  'id',
  'title',
  'body',
  'severity',
  'requiresChanges',
  'disposition',
  'lensRefs',
  'path',
  'line',
  'side',
  'reason',
];
const LOCATION_FIELDS = ['path', 'line', 'side'];
const RECONCILIATION_FIELDS = [
  'category',
  'title',
  'note',
  'findingId',
  'priorFindingId',
];
const FAILURE_FIELDS = ['kind', 'message'];

function pick(source, fields) {
  const picked = {};
  if (source === null || typeof source !== 'object') return picked;
  for (const field of fields) {
    if (source[field] !== undefined) picked[field] = source[field];
  }
  return picked;
}

function publicSubject(subject) {
  return {
    ...pick(subject, SUBJECT_FIELDS),
    ...(subject?.change === undefined
      ? {}
      : { change: pick(subject.change, CHANGE_FIELDS) }),
  };
}

function publicFinding(finding) {
  return {
    ...pick(finding, FINDING_FIELDS),
    ...(finding?.location === undefined
      ? {}
      : { location: pick(finding.location, LOCATION_FIELDS) }),
  };
}

function publicOutcome(outcome) {
  return {
    ...pick(outcome, OUTCOME_FIELDS),
    ...(outcome.subject === undefined
      ? {}
      : { subject: publicSubject(outcome.subject) }),
    ...(Array.isArray(outcome.findings)
      ? { findings: outcome.findings.map(publicFinding) }
      : {}),
    ...(Array.isArray(outcome.reconciliation)
      ? {
          reconciliation: outcome.reconciliation.map((entry) =>
            pick(entry, RECONCILIATION_FIELDS),
          ),
        }
      : {}),
  };
}

export function buildPublicArtifact({
  result,
  publication,
  requestedLenses = '',
}) {
  const outcome = result?.outcome;
  const lenses = selectedLenses(requestedLenses);
  return {
    schemaVersion: 1,
    status: result?.status ?? 'failed',
    ...(outcome === undefined ? {} : { outcome: publicOutcome(outcome) }),
    ...(result?.failure === undefined
      ? {}
      : { failure: pick(result.failure, FAILURE_FIELDS) }),
    diagnostics: {
      ...(typeof result?.diagnostics?.durationMs === 'number'
        ? { durationMs: result.diagnostics.durationMs }
        : {}),
    },
    ...(outcome === undefined
      ? {}
      : {
          configuration: {
            profile: outcome.profileName,
            model: outcome.model,
            ...(outcome.effort === undefined ? {} : { effort: outcome.effort }),
            ...(lenses === undefined ? {} : { lenses }),
          },
        }),
    publication: publication ?? null,
  };
}

// A file holding nothing but whitespace carries no more information than a
// missing one, and a review that fails before writing its result leaves one
// behind.
async function readJsonIfPresent(path) {
  if (!path) return undefined;
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  if (contents.trim() === '') return undefined;
  return JSON.parse(contents);
}

export async function writePublicArtifact({
  resultPath,
  publicationPath,
  artifactPath,
  requestedLenses,
}) {
  const artifact = buildPublicArtifact({
    result: await readJsonIfPresent(resultPath),
    publication: await readJsonIfPresent(publicationPath),
    requestedLenses,
  });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifact;
}
