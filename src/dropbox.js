import crypto from "node:crypto";
import { Readable } from "node:stream";

const OAUTH_COOKIE = "dropbox_oauth_state";

function encodeForm(values) {
  return new URLSearchParams(values).toString();
}

function dropboxHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

export function createDropboxAuthState() {
  return crypto.randomBytes(20).toString("hex");
}

export function dropboxAuthCookieName() {
  return OAUTH_COOKIE;
}

export function createDropboxAuthorizeUrl(state) {
  const url = new URL("https://www.dropbox.com/oauth2/authorize");
  url.searchParams.set("client_id", process.env.DROPBOX_APP_KEY || "");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("token_access_type", "offline");
  // Always force a fresh approval so new Dropbox scopes are actually granted.
  url.searchParams.set("force_reapprove", "true");
  url.searchParams.set(
    "redirect_uri",
    `${process.env.APP_BASE_URL || "http://localhost:8787"}/auth/dropbox/callback`,
  );
  url.searchParams.set(
    "scope",
    "account_info.read files.metadata.read files.content.read",
  );
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeDropboxCode(code) {
  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: encodeForm({
      code,
      grant_type: "authorization_code",
      client_id: process.env.DROPBOX_APP_KEY || "",
      client_secret: process.env.DROPBOX_APP_SECRET || "",
      redirect_uri: `${process.env.APP_BASE_URL || "http://localhost:8787"}/auth/dropbox/callback`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Dropbox token exchange failed: ${await response.text()}`);
  }

  return response.json();
}

export async function refreshDropboxAccessToken(refreshToken) {
  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: encodeForm({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: process.env.DROPBOX_APP_KEY || "",
      client_secret: process.env.DROPBOX_APP_SECRET || "",
    }),
  });

  if (!response.ok) {
    throw new Error(`Dropbox token refresh failed: ${await response.text()}`);
  }

  return response.json();
}

export async function getDropboxAccount(accessToken) {
  const response = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
    method: "POST",
    headers: dropboxHeaders(accessToken),
    body: "null",
  });

  if (!response.ok) {
    throw new Error(`Dropbox account lookup failed: ${await response.text()}`);
  }

  return response.json();
}

export async function listDropboxFolder(accessToken, folderPath = "", recursive = false) {
  const response = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
    method: "POST",
    headers: dropboxHeaders(accessToken),
    body: JSON.stringify({
      path: folderPath,
      recursive,
      include_deleted: false,
      include_non_downloadable_files: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Dropbox list_folder failed: ${await response.text()}`);
  }

  const firstPage = await response.json();
  const entries = [...firstPage.entries];
  let cursor = firstPage.cursor;
  let hasMore = firstPage.has_more;

  while (hasMore) {
    const nextResponse = await fetch("https://api.dropboxapi.com/2/files/list_folder/continue", {
      method: "POST",
      headers: dropboxHeaders(accessToken),
      body: JSON.stringify({ cursor }),
    });

    if (!nextResponse.ok) {
      throw new Error(`Dropbox list_folder/continue failed: ${await nextResponse.text()}`);
    }

    const nextPage = await nextResponse.json();
    entries.push(...nextPage.entries);
    cursor = nextPage.cursor;
    hasMore = nextPage.has_more;
  }

  return entries;
}

export async function downloadDropboxFile(accessToken, filePath) {
  const response = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Dropbox-API-Arg": JSON.stringify({ path: filePath }),
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Dropbox download failed for ${filePath}: ${await response.text()}`);
  }

  return Readable.fromWeb(response.body);
}
