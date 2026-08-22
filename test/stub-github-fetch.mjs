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
  const body = /\/comments(\?|$)/.test(String(url)) && options.method === 'GET'
    ? '[]'
    : '{"id":987654}';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
