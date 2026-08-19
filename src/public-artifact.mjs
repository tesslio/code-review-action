import { readFile, writeFile } from 'node:fs/promises';

import {
  isNoMatchingLensesResult,
  publicationReceipt,
} from './result-file.mjs';

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
// Each entry is the effort a lens is configured to run at, not proof that it
// ran: a lens whose globs select nothing is listed and skipped. Which lenses
// produced findings is recoverable from each finding's `lensRefs`.
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
const CONFIGURATION_FIELDS = ['profile', 'model', 'effort'];

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

// The only shape in the artifact that is an array of objects the CLI builds per
// run, so it is constructed rather than picked: a value of an unexpected type is
// dropped instead of serialized, and no nested structure can ride in on either
// field. The CLI already bounds a ref to a string and an effort to a fixed set,
// so this guards against a malformed result rather than a reachable input.
function publicLens(lens) {
  if (typeof lens?.ref !== 'string') return undefined;
  return {
    ref: lens.ref,
    ...(typeof lens.effort === 'string' ? { effort: lens.effort } : {}),
  };
}

function publicOutcome(outcome) {
  return {
    ...pick(outcome, OUTCOME_FIELDS),
    ...(outcome.subject === undefined
      ? {}
      : { subject: publicSubject(outcome.subject) }),
    ...(Array.isArray(outcome.lenses)
      ? {
          lenses: outcome.lenses
            .map(publicLens)
            .filter((lens) => lens !== undefined),
        }
      : {}),
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

function publicDiagnostics(diagnostics) {
  return typeof diagnostics?.durationMs === 'number'
    ? { durationMs: diagnostics.durationMs }
    : {};
}

function publicConfiguration(configuration, lenses) {
  const picked = {};
  for (const field of CONFIGURATION_FIELDS) {
    if (typeof configuration?.[field] === 'string' && configuration[field] !== '') {
      picked[field] = configuration[field];
    }
  }
  return {
    ...picked,
    ...(lenses === undefined ? {} : { lenses }),
  };
}

export function buildPublicArtifact({
  result,
  requestedLenses = '',
  requestedConfiguration = {},
}) {
  const outcome = result?.outcome;
  const lenses = selectedLenses(requestedLenses);
  const configuration =
    outcome === undefined
      ? publicConfiguration(requestedConfiguration, lenses)
      : publicConfiguration(
          {
            profile: outcome.profileName,
            model: outcome.model,
            effort: outcome.effort,
          },
          lenses,
        );
  return {
    schemaVersion: 1,
    status: result?.status ?? 'failed',
    ...(isNoMatchingLensesResult(result)
      ? { reason: result.reason }
      : {}),
    ...(outcome === undefined ? {} : { outcome: publicOutcome(outcome) }),
    ...(result?.failure === undefined
      ? {}
      : { failure: pick(result.failure, FAILURE_FIELDS) }),
    diagnostics: publicDiagnostics(result?.diagnostics),
    ...(Object.keys(configuration).length === 0 ? {} : { configuration }),
    // Read from the CLI's result rather than a receipt of this Action's own:
    // publication is the CLI's, so what it reports is what the artifact carries.
    publication: publicationReceipt(result) ?? null,
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
  artifactPath,
  requestedLenses,
  requestedConfiguration,
}) {
  const artifact = buildPublicArtifact({
    result: await readJsonIfPresent(resultPath),
    requestedLenses,
    requestedConfiguration,
  });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifact;
}
