import { appendFileSync } from 'node:fs';

// Records every GitHub request an entry script makes so a test can assert on
// the requests themselves rather than on a spy.
globalThis.fetch = async (url, options) => {
  appendFileSync(
    process.env.REQUEST_LOG,
    `${options.method} ${url} ${options.body ?? ''}\n`,
  );
  // A list endpoint answers with a collection, and a script that reads one
  // treats the single-object body every other endpoint returns as a bug in
  // itself rather than in the stub.
  // A published review answers with its own body, which is what the run page
  // shows: the review is fetched rather than re-rendered.
  const body = /\/comments(\?|$)/.test(String(url)) && options.method === 'GET'
    ? '[]'
    : /\/reviews\/\d+$/.test(String(url))
      ? '{"id":987654,"body":"## Tessl Code Review\\n\\n### Changes approved\\n\\nThe change is sound."}'
      : '{"id":987654}';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
