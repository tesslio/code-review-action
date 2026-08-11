import { appendFileSync } from 'node:fs';

// Records every GitHub request an entry script makes so a test can assert on
// the requests themselves rather than on a spy.
globalThis.fetch = async (url, options) => {
  appendFileSync(
    process.env.REQUEST_LOG,
    `${options.method} ${url} ${options.body ?? ''}\n`,
  );
  return new Response('{"id":987654}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
