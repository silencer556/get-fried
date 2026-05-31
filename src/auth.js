import crypto from "node:crypto";

// Minimal, dependency-light auth: two shared passwords (editor / viewer) map to
// two roles. On login we hand back an HMAC-signed cookie carrying the role, so
// no server-side session store is needed. Cloudflare Access is expected to sit
// in front of this for real identity; this is the in-app capability gate.
const SECRET =
  process.env.SESSION_SECRET ||
  crypto.randomBytes(32).toString("hex"); // ephemeral if unset (logs out on restart)

const EDITOR_PASSWORD = process.env.EDITOR_PASSWORD || "editor";
const VIEWER_PASSWORD = process.env.VIEWER_PASSWORD || "viewer";

function sign(role) {
  const payload = `${role}.${Date.now()}`;
  const mac = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return `${payload}.${mac}`;
}

function verify(token) {
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  if (idx < 0) return null;
  const payload = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(payload)
    .digest("hex");
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected)))
    return null;
  return payload.split(".")[0]; // role
}

export function roleForPassword(password) {
  if (password === EDITOR_PASSWORD) return "editor";
  if (password === VIEWER_PASSWORD) return "viewer";
  return null;
}

export function makeCookie(role) {
  return sign(role);
}

// Populates req.role from the cookie ("editor" | "viewer" | null).
export function attachRole(req, _res, next) {
  req.role = verify(req.cookies?.afsession) || null;
  next();
}

export function requireEditor(req, res, next) {
  if (req.role === "editor") return next();
  res.status(403).json({ error: "Editor access required." });
}
