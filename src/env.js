// Load a local .env for development (Node 22+ built-in, no dependency).
// In Docker the env comes from docker-compose and no .env file is shipped in the
// image, so loadEnvFile throws ENOENT — we ignore it. Imported first by
// server.js so db.js / auth.js see the variables at their top-level reads.
try {
  process.loadEnvFile();
} catch {
  /* no .env file present (e.g. in the container) — fine */
}
