#!/usr/bin/env node

import { requiredEnv } from './env.mjs';
import { writePublicArtifact } from './public-artifact.mjs';

const artifact = await writePublicArtifact({
  resultPath: process.env.REVIEW_OUTPUT,
  publicationPath: process.env.PUBLISH_OUTPUT,
  artifactPath: requiredEnv('PUBLIC_ARTIFACT_OUTPUT'),
  requestedLenses: process.env.LENSES,
});

console.log(JSON.stringify({ status: artifact.status }));
