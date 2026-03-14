const state = {
  currentBrowsePath: "",
  selectedFolderPath: "",
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

function renderPreviewBox(title, summary, body) {
  const previewSummary = document.getElementById("preview-summary");
  previewSummary.innerHTML = `
    <span class="label">${escapeHtml(title)}</span>
    <strong>${escapeHtml(summary)}</strong>
    <p>${escapeHtml(body)}</p>
  `;
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
    `;
    state.selectedFolderPath = payload.dropbox.selectedFolderPath || "";
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
  document.getElementById("browser-path").textContent = payload.currentPath || "/";

  const folderList = document.getElementById("folder-list");
  if (!payload.folders.length && !payload.currentPath) {
    folderList.innerHTML = `<p class="muted">No folders at the Dropbox root yet.</p>`;
    return;
  }

  folderList.innerHTML = payload.folders.length
    ? payload.folders
        .map(
          (folder) => `
            <div class="folder-row ${folder.path === state.selectedFolderPath ? "selected" : ""}">
              <div class="folder-copy">
                <span>${escapeHtml(folder.name)}</span>
                <code>${escapeHtml(folder.path)}</code>
              </div>
              <div class="folder-actions">
                <button class="button button-secondary browse-folder" data-path="${escapeHtml(folder.path)}" type="button">Open</button>
                <button class="button button-primary choose-folder" data-path="${escapeHtml(folder.path)}" data-name="${escapeHtml(folder.name)}" type="button">Use</button>
              </div>
            </div>
          `,
        )
        .join("")
    : `<p class="muted">No subfolders here.</p>`;

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
  document.getElementById("browse-root").addEventListener("click", () => {
    browse("");
  });

  document.getElementById("browse-up").addEventListener("click", () => {
    browse(parentPath(state.currentBrowsePath));
  });

  document.getElementById("preview-copy-hero").addEventListener("click", async () => {
    const payload = await api("/api/preview/copy");
    document.getElementById("preview-output").textContent = JSON.stringify(payload, null, 2);
    renderPreviewBox("Copy preview", payload.summary, "Review the uploads before running a live copy.");
  });

  document.getElementById("r2-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await api("/api/config/r2", {
      method: "POST",
      body: JSON.stringify({
        accountId: form.accountId.value || form.accountId.placeholder,
        bucket: form.bucket.value || form.bucket.placeholder,
        prefix: form.prefix.value || form.prefix.placeholder,
        accessKeyId: form.accessKeyId.value || "",
        secretAccessKey: form.secretAccessKey.value || "",
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
    const payload = await api("/api/preview/copy");
    document.getElementById("preview-output").textContent = JSON.stringify(payload, null, 2);
    renderPreviewBox("Copy preview", payload.summary, "Safe mode uploads new and changed files without deleting from R2.");
  });

  document.getElementById("preview-sync").addEventListener("click", async () => {
    const payload = await api("/api/preview/sync");
    document.getElementById("preview-output").textContent = JSON.stringify(payload, null, 2);
    renderPreviewBox("Mirror preview", payload.summary, "Mirror mode includes deletions and should be reviewed carefully.");
  });

  document.getElementById("run-copy").addEventListener("click", async () => {
    const payload = await api("/api/run/copy", { method: "POST" });
    document.getElementById("preview-output").textContent = JSON.stringify(payload, null, 2);
    renderPreviewBox("Copy finished", payload.summary, "R2 was updated in safe mode.");
    await loadState();
    showToast("Copy completed.", "success");
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
    const payload = await api("/api/run/sync", {
      method: "POST",
      body: JSON.stringify({ confirmation }),
    });
    document.getElementById("preview-output").textContent = JSON.stringify(payload, null, 2);
    renderPreviewBox("Mirror finished", payload.summary, "R2 now mirrors Dropbox, including deletions.");
    await loadState();
    showToast("Mirror completed.", "success");
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
