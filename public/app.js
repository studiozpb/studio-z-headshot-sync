const state = {
  currentBrowsePath: "",
  selectedFolderPath: "",
  selectedFolderName: "Dropbox Root",
  currentFolders: [],
  folderSearchQuery: "",
  actionBusy: false,
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }

  return response.json();
}

function formatTime(value) {
  if (!value) {
    return "Never";
  }
  return new Date(value).toLocaleString();
}

function showToast(message, tone = "neutral") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = `toast ${tone}`;
  toast.hidden = false;

  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.hidden = true;
  }, 2800);
}

function setActionBusy(isBusy, options = {}) {
  state.actionBusy = isBusy;
  const targets = [
    document.getElementById("preview-sync-hero"),
    document.getElementById("preview-copy"),
    document.getElementById("run-copy"),
    document.getElementById("preview-sync"),
    document.getElementById("run-sync"),
  ];

  for (const button of targets) {
    if (!button) {
      continue;
    }
    button.disabled = isBusy;
    button.classList.toggle("button-busy", isBusy);
  }

  if (!isBusy) {
    document.getElementById("preview-sync-hero").textContent = "Preview Sync";
    document.getElementById("preview-copy").textContent = "Preview Sync";
    document.getElementById("run-copy").textContent = "Sync";
    document.getElementById("preview-sync").textContent = "Preview Mirror";
    document.getElementById("run-sync").textContent = "Apply Mirror";
    return;
  }

  if (options.type === "preview-sync") {
    document.getElementById("preview-sync-hero").textContent = "Previewing…";
    document.getElementById("preview-copy").textContent = "Previewing…";
  }

  if (options.type === "run-sync") {
    document.getElementById("run-copy").textContent = "Syncing…";
  }

  if (options.type === "preview-mirror") {
    document.getElementById("preview-sync").textContent = "Previewing…";
  }

  if (options.type === "run-mirror") {
    document.getElementById("run-sync").textContent = "Running…";
  }
}

function renderPreviewBox(title, summary, body) {
  const previewSummary = document.getElementById("preview-summary");
  previewSummary.innerHTML = `
    <span class="label">${escapeHtml(title)}</span>
    <strong>${escapeHtml(summary)}</strong>
    <p>${escapeHtml(body)}</p>
  `;
}

function displayFolderName(path) {
  if (!path) {
    return "Dropbox Root";
  }
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) || "Dropbox Root";
}

function renderGrantedScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return `<p class="muted scope-copy">Granted scopes are not available yet. Reconnect Dropbox after approving access to refresh them.</p>`;
  }

  const chips = scopes
    .map((scope) => `<span class="scope-chip">${escapeHtml(scope)}</span>`)
    .join("");
  const hasContentRead = scopes.includes("files.content.read");
  const statusCopy = hasContentRead
    ? "This token can download files from Dropbox."
    : "This token cannot download files yet. Click Submit in Dropbox, then reconnect here.";

  return `
    <div class="scope-stack">
      <span class="label">Granted scopes</span>
      <div class="scope-row">${chips}</div>
      <p class="muted scope-copy">${escapeHtml(statusCopy)}</p>
    </div>
  `;
}

function renderFolderList() {
  const folderList = document.getElementById("folder-list");
  const folderCount = document.getElementById("folder-count");
  const query = state.folderSearchQuery.trim().toLowerCase();

  const filteredFolders = query
    ? state.currentFolders.filter((folder) => {
        const name = folder.name.toLowerCase();
        const fullPath = folder.path.toLowerCase();
        return name.includes(query) || fullPath.includes(query);
      })
    : state.currentFolders;

  if (state.currentFolders.length === 0) {
    folderCount.textContent = state.currentBrowsePath
      ? "No folders in this level"
      : "No folders at Dropbox root";
    folderList.innerHTML = `<p class="muted folder-empty">No folders found in this level.</p>`;
    return;
  }

  folderCount.textContent = query
    ? `${filteredFolders.length} of ${state.currentFolders.length} folders shown`
    : `${state.currentFolders.length} folders in this level`;

  if (filteredFolders.length === 0) {
    folderList.innerHTML = `<p class="muted folder-empty">No folders match “${escapeHtml(state.folderSearchQuery)}”.</p>`;
    return;
  }

  folderList.innerHTML = filteredFolders
    .map(
      (folder) => `
        <div class="folder-row ${folder.path === state.selectedFolderPath ? "selected" : ""}">
          <div class="folder-copy">
            <span class="folder-name">${escapeHtml(folder.name)}</span>
            <code>${escapeHtml(folder.path)}</code>
          </div>
          <div class="folder-actions">
            <button class="button button-secondary browse-folder" data-path="${escapeHtml(folder.path)}" type="button">Open</button>
            <button class="button button-primary choose-folder" data-path="${escapeHtml(folder.path)}" data-name="${escapeHtml(folder.name)}" type="button">Use</button>
          </div>
        </div>
      `,
    )
    .join("");

  folderList.querySelectorAll(".browse-folder").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const nextPath = event.currentTarget.dataset.path || "";
      await browse(nextPath);
    });
  });

  folderList.querySelectorAll(".choose-folder").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const nextPath = event.currentTarget.dataset.path || "";
      const name = event.currentTarget.dataset.name || nextPath || "Dropbox Root";
      await selectFolder(nextPath, name);
    });
  });
}

function renderPublicState(payload) {
  const connectedDropbox = payload.dropbox.connected;
  const configuredR2 = payload.r2.configured;
  const destinationText = payload.r2.bucket
    ? `${payload.r2.bucket}${payload.r2.prefix ? `/${payload.r2.prefix}` : ""}`
    : "Not configured";
  const autoCopyEnabled = Boolean(payload.sync.autoCopyEnabled);

  document.getElementById("last-run").textContent = formatTime(payload.sync.lastRunAt);
  document.getElementById("last-outcome").textContent =
    payload.sync.lastSummary || `Outcome: ${payload.sync.lastOutcome || "idle"}`;
  document.getElementById("selected-folder").textContent =
    payload.dropbox.selectedFolderPath || "/";
  document.getElementById("dropbox-status").textContent = connectedDropbox
    ? "Connected"
    : "Not connected";
  document.getElementById("dropbox-meta").textContent = connectedDropbox
    ? payload.dropbox.account?.email || "Dropbox account ready"
    : "Connect Dropbox to browse folders";
  document.getElementById("destination-status").textContent = configuredR2
    ? "Ready"
    : "Not configured";
  document.getElementById("destination-meta").textContent = configuredR2
    ? destinationText
    : "Add account, bucket, and keys";
  document.getElementById("copy-mode").textContent = autoCopyEnabled
    ? "Auto copy enabled"
    : "Manual copy only";

  const account = document.getElementById("dropbox-account");
  if (!payload.dropbox.connected) {
    account.innerHTML = `<p class="muted">Dropbox is not connected yet. Use the connect action above to authorize the dashboard and browse your folders.</p>`;
  } else {
    account.innerHTML = `
      <div class="info-grid">
        <div><span class="label">Account</span><strong>${escapeHtml(payload.dropbox.account?.name || "")}</strong></div>
        <div><span class="label">Email</span><strong>${escapeHtml(payload.dropbox.account?.email || "")}</strong></div>
        <div><span class="label">Selected folder</span><strong>${escapeHtml(payload.dropbox.selectedFolderPath || "/")}</strong></div>
      </div>
      ${renderGrantedScopes(payload.dropbox.grantedScopes)}
    `;
    state.selectedFolderPath = payload.dropbox.selectedFolderPath || "";
    state.selectedFolderName = payload.dropbox.selectedFolderName || "Dropbox Root";
  }

  document.getElementById("selected-folder-card-name").textContent =
    payload.dropbox.selectedFolderName || "Dropbox Root";
  document.getElementById("selected-folder-card-path").textContent =
    payload.dropbox.selectedFolderPath || "/";

  const r2Form = document.getElementById("r2-form");
  r2Form.accountId.value = payload.r2.accountId || "";
  r2Form.bucket.value = payload.r2.bucket || "";
  r2Form.prefix.value = payload.r2.prefix || "";
  r2Form.accessKeyId.value = "";
  r2Form.secretAccessKey.value = "";
  r2Form.dataset.hasStoredAccountId = payload.r2.accountId ? "true" : "false";
  r2Form.dataset.hasStoredBucket = payload.r2.bucket ? "true" : "false";
  r2Form.dataset.hasStoredAccessKey = payload.r2.accessKeyIdPreview ? "true" : "false";
  r2Form.dataset.hasStoredSecretKey = payload.r2.secretAccessKeyPreview ? "true" : "false";
  r2Form.accountId.placeholder = payload.r2.accountId || "";
  r2Form.bucket.placeholder = payload.r2.bucket || "";
  r2Form.prefix.placeholder = payload.r2.prefix || "event-slug";
  r2Form.accessKeyId.placeholder = payload.r2.accessKeyIdPreview || "";
  r2Form.secretAccessKey.placeholder = payload.r2.secretAccessKeyPreview || "";
  document.getElementById("destination-card-bucket").textContent = payload.r2.bucket || "Not configured";
  document.getElementById("destination-card-prefix").textContent =
    payload.r2.prefix ? `/${payload.r2.prefix}` : "/";

  const syncForm = document.getElementById("sync-form");
  syncForm.autoCopyEnabled.checked = Boolean(payload.sync.autoCopyEnabled);
  syncForm.intervalSeconds.value = payload.sync.intervalSeconds || 60;

  const history = document.getElementById("history");
  history.innerHTML = payload.runs.length
    ? payload.runs
        .map(
          (run) => `
            <article class="history-card">
              <div class="history-head">
                <strong>${run.destructive ? "Mirror" : "Copy"}</strong>
                <span class="pill ${run.outcome}">${run.outcome}</span>
              </div>
              <p>${escapeHtml(run.summary)}</p>
              <small>${formatTime(run.startedAt || run.endedAt)}</small>
            </article>
          `,
        )
        .join("")
    : `<p class="muted">No sync runs yet.</p>`;
}

async function loadState() {
  const payload = await api("/api/state");
  renderPublicState(payload);
}

async function browse(path = "") {
  const payload = await api(`/api/dropbox/browse?path=${encodeURIComponent(path)}`);
  state.currentBrowsePath = payload.currentPath || "";
  state.currentFolders = payload.folders || [];
  state.folderSearchQuery = "";
  document.getElementById("browser-path").textContent = payload.currentPath || "/";
  document.getElementById("folder-search").value = "";
  renderFolderList();
}

async function selectFolder(path, name) {
  await api("/api/dropbox/select-folder", {
    method: "POST",
    body: JSON.stringify({ path, name }),
  });
  state.selectedFolderPath = path;
  await loadState();
  await browse(path);
  showToast(`Selected ${name}`, "success");
}

function parentPath(currentPath) {
  if (!currentPath) {
    return "";
  }
  const parts = currentPath.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "";
}

function attachEvents() {
  document.getElementById("folder-search").addEventListener("input", (event) => {
    state.folderSearchQuery = event.currentTarget.value || "";
    renderFolderList();
  });

  document.getElementById("browse-root").addEventListener("click", () => {
    browse("");
  });

  document.getElementById("browse-up").addEventListener("click", () => {
    browse(parentPath(state.currentBrowsePath));
  });

  document.getElementById("use-current-folder").addEventListener("click", async () => {
    const currentPath = state.currentBrowsePath || "";
    await selectFolder(currentPath, displayFolderName(currentPath));
  });

  document.getElementById("preview-sync-hero").addEventListener("click", async () => {
    try {
      setActionBusy(true, { type: "preview-sync" });
      renderPreviewBox("Previewing sync", "Working…", "Checking Dropbox against the current R2 destination.");
      const payload = await api("/api/preview/copy");
      document.getElementById("preview-output").textContent = JSON.stringify(payload, null, 2);
      renderPreviewBox("Sync preview", payload.summary, "Review the uploads before running a live sync.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Preview failed";
      renderPreviewBox("Preview failed", message, "The sync preview could not be generated.");
      showToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  });

  document.getElementById("r2-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const accountId = (form.accountId.value || "").trim();
    const bucket = (form.bucket.value || "").trim();
    const prefix = (form.prefix.value || "").trim();
    const accessKeyId = (form.accessKeyId.value || "").trim();
    const secretAccessKey = (form.secretAccessKey.value || "").trim();
    const hasStoredAccountId = form.dataset.hasStoredAccountId === "true";
    const hasStoredBucket = form.dataset.hasStoredBucket === "true";
    const hasStoredAccessKey = form.dataset.hasStoredAccessKey === "true";
    const hasStoredSecretKey = form.dataset.hasStoredSecretKey === "true";

    if (!accountId && !hasStoredAccountId) {
      showToast("Enter the R2 account ID once before saving.", "error");
      form.accountId.focus();
      return;
    }

    if (!bucket && !hasStoredBucket) {
      showToast("Enter the R2 bucket name once before saving.", "error");
      form.bucket.focus();
      return;
    }

    if (!accessKeyId && !hasStoredAccessKey) {
      showToast("Enter the R2 access key ID once before saving.", "error");
      form.accessKeyId.focus();
      return;
    }

    if (!secretAccessKey && !hasStoredSecretKey) {
      showToast("Enter the R2 secret key once before saving.", "error");
      form.secretAccessKey.focus();
      return;
    }

    await api("/api/config/r2", {
      method: "POST",
      body: JSON.stringify({
        accountId,
        bucket,
        prefix,
        accessKeyId,
        secretAccessKey,
      }),
    });
    await loadState();
    showToast("R2 settings saved.", "success");
    form.accessKeyId.value = "";
    form.secretAccessKey.value = "";
  });

  document.getElementById("sync-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await api("/api/config/sync", {
      method: "POST",
      body: JSON.stringify({
        autoCopyEnabled: form.autoCopyEnabled.checked,
        intervalSeconds: Number(form.intervalSeconds.value || 60),
      }),
    });
    await loadState();
    showToast("Copy settings saved.", "success");
  });

  document.getElementById("preview-copy").addEventListener("click", async () => {
    try {
      setActionBusy(true, { type: "preview-sync" });
      renderPreviewBox("Previewing sync", "Working…", "Checking Dropbox against the current R2 destination.");
      const payload = await api("/api/preview/copy");
      document.getElementById("preview-output").textContent = JSON.stringify(payload, null, 2);
      renderPreviewBox("Sync preview", payload.summary, "Safe mode uploads new and changed files without deleting from R2.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Preview failed";
      renderPreviewBox("Preview failed", message, "The sync preview could not be generated.");
      showToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  });

  document.getElementById("preview-sync").addEventListener("click", async () => {
    try {
      setActionBusy(true, { type: "preview-mirror" });
      renderPreviewBox("Previewing mirror", "Working…", "Checking Dropbox and R2 for adds, changes, and deletions.");
      const payload = await api("/api/preview/sync");
      document.getElementById("preview-output").textContent = JSON.stringify(payload, null, 2);
      renderPreviewBox("Mirror preview", payload.summary, "Mirror mode includes deletions and should be reviewed carefully.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Mirror preview failed";
      renderPreviewBox("Mirror preview failed", message, "The destructive preview could not be generated.");
      showToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  });

  document.getElementById("run-copy").addEventListener("click", async () => {
    try {
      setActionBusy(true, { type: "run-sync" });
      renderPreviewBox("Syncing", "Working…", "Uploading new and changed files to R2 in safe mode.");
      const payload = await api("/api/run/copy", { method: "POST" });
      document.getElementById("preview-output").textContent = JSON.stringify(payload, null, 2);
      renderPreviewBox("Sync finished", payload.summary, "R2 was updated in safe mode.");
      await loadState();
      showToast("Sync completed.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed";
      renderPreviewBox("Sync failed", message, "The safe sync did not complete.");
      showToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  });

  document.getElementById("run-sync").addEventListener("click", async () => {
    const challenge = new Date().toISOString().slice(0, 10);
    const confirmation = window.prompt(
      `Type today's UTC date (${challenge}) to confirm a destructive mirror.`,
      "",
    );
    if (!confirmation) {
      return;
    }
    try {
      setActionBusy(true, { type: "run-mirror" });
      renderPreviewBox("Running mirror", "Working…", "Applying Dropbox changes to R2, including deletions.");
      const payload = await api("/api/run/sync", {
        method: "POST",
        body: JSON.stringify({ confirmation }),
      });
      document.getElementById("preview-output").textContent = JSON.stringify(payload, null, 2);
      renderPreviewBox("Mirror finished", payload.summary, "R2 now mirrors Dropbox, including deletions.");
      await loadState();
      showToast("Mirror completed.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Mirror failed";
      renderPreviewBox("Mirror failed", message, "The destructive mirror did not complete.");
      showToast(message, "error");
    } finally {
      setActionBusy(false);
    }
  });
}

attachEvents();
loadState()
  .then(() => browse(""))
  .catch((error) => {
    document.getElementById("preview-output").textContent = error.message;
    renderPreviewBox("Connection error", error.message, "Check your server configuration and try again.");
    showToast(error.message, "error");
  });
