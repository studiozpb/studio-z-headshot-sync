import path from "node:path";
import {
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { downloadDropboxFile, listDropboxFolder, refreshDropboxAccessToken } from "./dropbox.js";
import { appendRun, getState, updateState } from "./storage.js";

function normalizeDropboxPath(input) {
  if (!input || input === "/") {
    return "";
  }
  return input.startsWith("/") ? input : `/${input}`;
}

function normalizeR2Prefix(input) {
  return (input || "").replace(/^\/+|\/+$/g, "");
}

function joinR2Key(prefix, relativePath) {
  const normalizedPrefix = normalizeR2Prefix(prefix);
  const normalizedPath = relativePath.replace(/^\/+/, "");
  return normalizedPrefix ? `${normalizedPrefix}/${normalizedPath}` : normalizedPath;
}

function relativeDropboxPath(rootPath, fullPath) {
  const normalizedRoot = normalizeDropboxPath(rootPath);
  if (!normalizedRoot) {
    return fullPath.replace(/^\/+/, "");
  }
  return fullPath.slice(normalizedRoot.length).replace(/^\/+/, "");
}

function maskSecret(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 6) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, 3)}${"*".repeat(value.length - 6)}${value.slice(-3)}`;
}

function summarizePlan(plan) {
  return `${plan.uploads.length} uploads, ${plan.deletes.length} deletes, ${plan.skips.length} unchanged`;
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".heic":
      return "image/heic";
    default:
      return "application/octet-stream";
  }
}

async function getDropboxAccessToken(refreshToken) {
  const refreshed = await refreshDropboxAccessToken(refreshToken);
  return refreshed.access_token;
}

function createR2Client(r2) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
    },
  });
}

async function listR2Keys(client, bucket, prefix) {
  const keys = new Set();
  let continuationToken;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: normalizeR2Prefix(prefix) || undefined,
        ContinuationToken: continuationToken,
      }),
    );

    for (const item of page.Contents || []) {
      if (item.Key) {
        keys.add(item.Key);
      }
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
}

function validateState(state) {
  const failures = [];

  if (!state.dropbox.refreshToken) {
    failures.push("Dropbox is not connected");
  }
  if (!state.dropbox.selectedFolderPath && state.dropbox.selectedFolderPath !== "") {
    failures.push("No Dropbox folder selected");
  }
  if (!state.r2.accountId || !state.r2.bucket || !state.r2.accessKeyId || !state.r2.secretAccessKey) {
    failures.push("R2 settings are incomplete");
  }

  if (failures.length > 0) {
    throw new Error(failures.join(". "));
  }
}

async function buildPlan(state) {
  validateState(state);

  const accessToken = await getDropboxAccessToken(state.dropbox.refreshToken);
  const selectedFolderPath = normalizeDropboxPath(state.dropbox.selectedFolderPath);
  const manifest = state.manifests[selectedFolderPath] || {};
  const entries = await listDropboxFolder(accessToken, selectedFolderPath, true);
  const files = entries.filter((entry) => entry[".tag"] === "file");

  const r2Client = createR2Client(state.r2);
  await r2Client.send(new HeadBucketCommand({ Bucket: state.r2.bucket }));
  const r2Keys = await listR2Keys(r2Client, state.r2.bucket, state.r2.prefix);

  const currentFiles = new Map();
  const uploads = [];
  const skips = [];

  for (const file of files) {
    const relativePath = relativeDropboxPath(selectedFolderPath, file.path_display);
    const destinationKey = joinR2Key(state.r2.prefix, relativePath);
    currentFiles.set(relativePath, {
      contentHash: file.content_hash,
      size: file.size,
      rev: file.rev,
      serverModified: file.server_modified,
      pathDisplay: file.path_display,
      destinationKey,
    });

    const previous = manifest[relativePath];
    if (
      previous &&
      previous.contentHash === file.content_hash &&
      previous.destinationKey === destinationKey &&
      r2Keys.has(destinationKey)
    ) {
      skips.push({ relativePath, destinationKey });
      continue;
    }

    uploads.push({
      relativePath,
      dropboxPath: file.path_display,
      destinationKey,
      contentHash: file.content_hash,
      size: file.size,
      rev: file.rev,
      serverModified: file.server_modified,
    });
  }

  const deletes = [];
  for (const [relativePath, previous] of Object.entries(manifest)) {
    if (!currentFiles.has(relativePath)) {
      deletes.push({
        relativePath,
        destinationKey: previous.destinationKey,
      });
    }
  }

  return {
    accessToken,
    r2Client,
    selectedFolderPath,
    currentFiles,
    uploads,
    deletes,
    skips,
  };
}

async function finalizeRun(runId, outcome, summary, extra = {}) {
  await updateState((state) => {
    state.sync.lastRunAt = new Date().toISOString();
    state.sync.lastOutcome = outcome;
    state.sync.lastSummary = summary;
    if (state.sync.activeRun?.id === runId) {
      state.sync.activeRun = null;
    }
  });

  await appendRun({
    id: runId,
    endedAt: new Date().toISOString(),
    outcome,
    summary,
    ...extra,
  });
}

export async function getPublicState() {
  const state = await getState();
  return {
    dropbox: {
      connected: Boolean(state.dropbox.refreshToken),
      account: state.dropbox.account,
      selectedFolderPath: state.dropbox.selectedFolderPath,
      selectedFolderName: state.dropbox.selectedFolderName,
    },
    r2: {
      configured: Boolean(
        state.r2.accountId &&
          state.r2.bucket &&
          state.r2.accessKeyId &&
          state.r2.secretAccessKey,
      ),
      accountId: state.r2.accountId,
      bucket: state.r2.bucket,
      prefix: state.r2.prefix,
      accessKeyIdPreview: maskSecret(state.r2.accessKeyId),
      secretAccessKeyPreview: maskSecret(state.r2.secretAccessKey),
    },
    sync: state.sync,
    runs: state.runs,
  };
}

export async function previewSync({ destructive }) {
  const state = await getState();
  const plan = await buildPlan(state);
  return {
    mode: destructive ? "sync" : "copy",
    selectedFolderPath: plan.selectedFolderPath || "/",
    summary: summarizePlan(plan),
    uploads: plan.uploads.slice(0, 100),
    deletes: destructive ? plan.deletes.slice(0, 100) : [],
    skips: plan.skips.length,
    totalUploads: plan.uploads.length,
    totalDeletes: destructive ? plan.deletes.length : 0,
  };
}

export async function runSync({ destructive, source }) {
  const state = await getState();
  if (state.sync.activeRun) {
    throw new Error("A sync is already running");
  }

  const runId = `${Date.now()}`;
  const startedAt = new Date().toISOString();

  await updateState((draft) => {
    draft.sync.activeRun = {
      id: runId,
      startedAt,
      source,
      destructive,
    };
  });

  try {
    const plan = await buildPlan(state);
    const nextManifest = {};
    const uploadResults = [];
    const deleteResults = [];

    for (const upload of plan.uploads) {
      const body = await downloadDropboxFile(plan.accessToken, upload.dropboxPath);
      await plan.r2Client.send(
        new PutObjectCommand({
          Bucket: state.r2.bucket,
          Key: upload.destinationKey,
          Body: body,
          ContentType: guessContentType(upload.relativePath),
          Metadata: {
            "dropbox-content-hash": upload.contentHash,
            "dropbox-rev": upload.rev,
            "dropbox-server-modified": upload.serverModified,
          },
        }),
      );

      uploadResults.push(upload);
      nextManifest[upload.relativePath] = {
        contentHash: upload.contentHash,
        destinationKey: upload.destinationKey,
        rev: upload.rev,
        size: upload.size,
        serverModified: upload.serverModified,
      };
    }

    for (const skip of plan.skips) {
      const file = plan.currentFiles.get(skip.relativePath);
      nextManifest[skip.relativePath] = {
        contentHash: file.contentHash,
        destinationKey: file.destinationKey,
        rev: file.rev,
        size: file.size,
        serverModified: file.serverModified,
      };
    }

    if (destructive) {
      for (const deletion of plan.deletes) {
        await plan.r2Client.send(
          new DeleteObjectCommand({
            Bucket: state.r2.bucket,
            Key: deletion.destinationKey,
          }),
        );
        deleteResults.push(deletion);
      }
    } else {
      const priorManifest = state.manifests[plan.selectedFolderPath] || {};
      for (const deletion of plan.deletes) {
        nextManifest[deletion.relativePath] = priorManifest[deletion.relativePath];
      }
    }

    await updateState((draft) => {
      draft.manifests[plan.selectedFolderPath] = nextManifest;
    });

    const summary = summarizePlan({
      uploads: uploadResults,
      deletes: deleteResults,
      skips: plan.skips,
    });

    await finalizeRun(runId, "success", summary, {
      startedAt,
      destructive,
      source,
      totalUploads: uploadResults.length,
      totalDeletes: deleteResults.length,
      totalSkips: plan.skips.length,
    });

    return {
      ok: true,
      summary,
      destructive,
      totalUploads: uploadResults.length,
      totalDeletes: deleteResults.length,
      totalSkips: plan.skips.length,
    };
  } catch (error) {
    const summary = error instanceof Error ? error.message : "Sync failed";
    await finalizeRun(runId, "error", summary, {
      startedAt,
      destructive,
      source,
    });
    throw error;
  }
}
