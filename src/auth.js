import crypto from "node:crypto";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const sessions = new Map();

function now() {
  return Date.now();
}

function sign(value) {
  return crypto
    .createHmac("sha256", process.env.SESSION_SECRET || "dev-session-secret")
    .update(value)
    .digest("hex");
}

export function createSession() {
  const id = crypto.randomBytes(24).toString("hex");
  const expiresAt = now() + SESSION_TTL_MS;
  sessions.set(id, expiresAt);
  return `${id}.${sign(id)}`;
}

export function clearExpiredSessions() {
  const current = now();
  for (const [id, expiresAt] of sessions.entries()) {
    if (expiresAt <= current) {
      sessions.delete(id);
    }
  }
}

export function validateSession(cookieValue) {
  clearExpiredSessions();

  if (!cookieValue) {
    return false;
  }

  const [id, signature] = cookieValue.split(".");
  if (!id || !signature) {
    return false;
  }

  if (sign(id) !== signature) {
    return false;
  }

  const expiresAt = sessions.get(id);
  if (!expiresAt || expiresAt <= now()) {
    sessions.delete(id);
    return false;
  }

  return true;
}

export function destroySession(cookieValue) {
  const [id] = (cookieValue || "").split(".");
  if (id) {
    sessions.delete(id);
  }
}

export function requireAuth(req, res, next) {
  if (validateSession(req.cookies.session)) {
    next();
    return;
  }

  if (req.path.startsWith("/api/")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  res.redirect("/login");
}
