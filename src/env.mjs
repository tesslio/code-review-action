export function requiredEnv(name, env = process.env) {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

const POSITIVE_INTEGER = /^[1-9]\d*$/;

export function requiredPositiveIntegerEnv(name, env = process.env) {
  const value = requiredEnv(name, env);
  if (!POSITIVE_INTEGER.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
}

// An empty value means the identifier was never produced, and any other value
// that is not a positive integer identifies nothing either, so both read as
// absent rather than as an error.
export function optionalPositiveIntegerEnv(name, env = process.env) {
  const value = env[name] ?? '';
  return POSITIVE_INTEGER.test(value) ? Number(value) : undefined;
}
