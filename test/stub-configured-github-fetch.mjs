import { appendFileSync } from 'node:fs';

/**
 * A GitHub stub whose status and body a test chooses, for the scripts that
 * branch on what GitHub answered rather than on having asked at all.
 *
 * `RESPONSE_BODY` is the body for every request; `RESPONSE_STATUS` defaults to
 * 200 so a test that only cares about the body says only that.
 */
globalThis.fetch = async (url, options) => {
  if (process.env.REQUEST_LOG) {
    appendFileSync(
      process.env.REQUEST_LOG,
      `${options.method ?? 'GET'} ${url}\n`,
    );
  }
  const status = Number(process.env.RESPONSE_STATUS ?? '200');
  return new Response(process.env.RESPONSE_BODY ?? '{}', {
    status,
    headers: { 'content-type': 'application/json' },
  });
};
