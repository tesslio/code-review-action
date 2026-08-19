// A GitHub that rejects every request, for the paths that have to survive one.
globalThis.fetch = async () =>
  new Response('{"message":"Resource not accessible by integration"}', {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
