import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { createSession, destroySession, requireAuth } from "./auth.js";
import {
  createDropboxAuthState,
  createDropboxAuthorizeUrl,
  dropboxAuthCookieName,
  exchangeDropboxCode,
  getDropboxAccount,
  listDropboxFolder,
  refreshDropboxAccessToken,
} from "./dropbox.js";
import { getPublicState, previewSync, runSync } from "./sync-engine.js";
import { getState, updateState } from "./storage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

const app = express();
const scheduler = {
  timer: null,
};

function parseCookies(req, _res, next) {
  const raw = req.headers.cookie || "";
  const cookies = {};
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (!key) {
      continue;
    }
    cookies[key] = decodeURIComponent(rest.join("=") || "");
  }
  req.cookies = cookies;
  next();
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  } else {
    parts.push("SameSite=Lax");
  }
  if (options.maxAgeSeconds) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  if (options.path) {
    parts.push(`Path=${options.path}`);
  } else {
    parts.push("Path=/");
  }
  res.append("Set-Cookie", parts.join("; "));
}

function clearCookie(res, name) {
  res.append("Set-Cookie", `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

function requireEnv(keys) {
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}

async function ensureDropboxAccessToken() {
  const state = await getState();
  if (!state.dropbox.refreshToken) {
    throw new Error("Dropbox is not connected");
  }
  const refreshed = await refreshDropboxAccessToken(state.dropbox.refreshToken);
  return refreshed.access_token;
}

function scheduleAutoCopy() {
  if (scheduler.timer) {
    clearInterval(scheduler.timer);
  }

  scheduler.timer = setInterval(async () => {
    const state = await getState();
    if (!state.sync.autoCopyEnabled) {
      return;
    }
    if (state.sync.activeRun) {
      return;
    }

    const lastRunTime = state.sync.lastRunAt ? new Date(state.sync.lastRunAt).getTime() : 0;
    const intervalMs = Math.max(15, Number(state.sync.intervalSeconds || 60)) * 1000;
    if (Date.now() - lastRunTime < intervalMs) {
      return;
    }

    try {
      await runSync({ destructive: false, source: "scheduler" });
    } catch (error) {
      console.error("Auto copy failed", error);
    }
  }, 15000);
}

app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "2mb" }));
app.use(parseCookies);
app.use(
  express.static(publicDir, {
    index: false,
  }),
);

app.get("/login", (_req, res) => {
  res.sendFile(path.join(publicDir, "login.html"));
});

app.post("/login", (req, res) => {
  if (!process.env.ADMIN_PASSWORD) {
    res.status(500).send("ADMIN_PASSWORD is not configured");
    return;
  }

  if (req.body.password !== process.env.ADMIN_PASSWORD) {
    res.status(401).send("Invalid password");
    return;
  }

  const sessionCookie = createSession();
  setCookie(res, "session", sessionCookie, { maxAgeSeconds: 60 * 60 * 24 * 14 });
  res.redirect("/");
});

app.post("/logout", requireAuth, (req, res) => {
  destroySession(req.cookies.session);
  clearCookie(res, "session");
  res.redirect("/login");
});

app.get("/auth/dropbox/start", requireAuth, (_req, res) => {
  requireEnv(["DROPBOX_APP_KEY", "DROPBOX_APP_SECRET", "APP_BASE_URL"]);
  const state = createDropboxAuthState();
  setCookie(res, dropboxAuthCookieName(), state, { maxAgeSeconds: 600 });
  res.redirect(createDropboxAuthorizeUrl(state));
});

app.get("/auth/dropbox/callback", requireAuth, async (req, res) => {
  const returnedState = String(req.query.state || "");
  if (!returnedState || returnedState !== req.cookies[dropboxAuthCookieName()]) {
    res.status(400).send("Invalid Dropbox OAuth state");
    return;
  }

  try {
    const code = String(req.query.code || "");
    if (!code) {
      throw new Error("Missing Dropbox OAuth code");
    }

    const tokenResult = await exchangeDropboxCode(code);
    if (!tokenResult.refresh_token) {
      throw new Error(
        "Dropbox did not return a refresh token. Reconnect Dropbox again after approving offline access.",
      );
    }
    const account = await getDropboxAccount(tokenResult.access_token);

    await updateState((state) => {
      state.dropbox.refreshToken = tokenResult.refresh_token;
      state.dropbox.grantedScopes = String(tokenResult.scope || "")
        .split(/\s+/)
        .filter(Boolean)
        .sort();
      state.dropbox.account = {
        accountId: account.account_id,
        email: account.email,
        name: account.name.display_name,
      };
      state.dropbox.selectedFolderPath = "";
      state.dropbox.selectedFolderName = "Dropbox Root";
    });

    clearCookie(res, dropboxAuthCookieName());
    res.redirect("/");
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : "Dropbox connect failed");
  }
});

app.get("/", requireAuth, (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/api/state", requireAuth, async (_req, res) => {
  res.json(await getPublicState());
});

app.get("/api/dropbox/browse", requireAuth, async (req, res) => {
  try {
    const accessToken = await ensureDropboxAccessToken();
    const folderPath = String(req.query.path || "");
    const entries = await listDropboxFolder(accessToken, folderPath, false);
    const folders = entries
      .filter((entry) => entry[".tag"] === "folder")
      .map((entry) => ({
        name: entry.name,
        path: entry.path_display,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      currentPath: folderPath || "",
      folders,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Browse failed" });
  }
});

app.post("/api/dropbox/select-folder", requireAuth, async (req, res) => {
  const selectedPath = typeof req.body.path === "string" ? req.body.path : "";
  const selectedName =
    typeof req.body.name === "string" && req.body.name.trim()
      ? req.body.name.trim()
      : selectedPath || "Dropbox Root";

  await updateState((state) => {
    state.dropbox.selectedFolderPath = selectedPath;
    state.dropbox.selectedFolderName = selectedName;
  });

  res.json({ ok: true });
});

app.post("/api/config/r2", requireAuth, async (req, res) => {
  await updateState((state) => {
    const accountId = String(req.body.accountId || "").trim();
    const bucket = String(req.body.bucket || "").trim();
    const prefix = String(req.body.prefix || "").trim();
    const accessKeyId = String(req.body.accessKeyId || "").trim();
    const secretAccessKey = String(req.body.secretAccessKey || "").trim();

    state.r2.accountId = accountId || state.r2.accountId;
    state.r2.bucket = bucket || state.r2.bucket;
    state.r2.prefix = prefix;
    state.r2.accessKeyId = accessKeyId || state.r2.accessKeyId;
    state.r2.secretAccessKey = secretAccessKey || state.r2.secretAccessKey;
  });
  res.json({ ok: true });
});

app.post("/api/config/sync", requireAuth, async (req, res) => {
  await updateState((state) => {
    state.sync.autoCopyEnabled = Boolean(req.body.autoCopyEnabled);
    state.sync.intervalSeconds = Math.max(15, Number(req.body.intervalSeconds || 60));
  });
  res.json({ ok: true });
});

app.get("/api/preview/copy", requireAuth, async (_req, res) => {
  try {
    res.json(await previewSync({ destructive: false }));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Preview failed" });
  }
});

app.get("/api/preview/sync", requireAuth, async (_req, res) => {
  try {
    res.json(await previewSync({ destructive: true }));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Preview failed" });
  }
});

app.post("/api/run/copy", requireAuth, async (_req, res) => {
  try {
    res.json(await runSync({ destructive: false, source: "manual-copy" }));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Copy failed" });
  }
});

app.post("/api/run/sync", requireAuth, async (req, res) => {
  const confirmation = String(req.body.confirmation || "");
  const challenge = new Date().toISOString().slice(0, 10);

  if (confirmation !== challenge) {
    res.status(400).json({
      error: `Confirmation failed. Type today's UTC date (${challenge}) to apply a destructive mirror.`,
    });
    return;
  }

  try {
    res.json(await runSync({ destructive: true, source: "manual-sync" }));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Sync failed" });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    instance: crypto.randomUUID(),
  });
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  scheduleAutoCopy();
  console.log(`Dropbox R2 dashboard listening on http://localhost:${port}`);
});
