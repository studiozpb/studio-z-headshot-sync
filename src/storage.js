import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const RUNS_LIMIT = 100;

const defaultState = () => ({
  dropbox: {
    account: null,
    refreshToken: null,
    grantedScopes: [],
    selectedFolderPath: "",
    selectedFolderName: "",
  },
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || "",
    bucket: process.env.R2_BUCKET || "",
    prefix: process.env.R2_PREFIX || "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
  sync: {
    autoCopyEnabled: false,
    autoMirrorEnabled: false,
    intervalSeconds: 60,
    lastRunAt: null,
    lastOutcome: "idle",
    lastSummary: "",
    activeRun: null,
  },
  manifests: {},
  runs: [],
});

let inMemoryState = null;

async function ensureStateLoaded() {
  if (inMemoryState) {
    return inMemoryState;
  }

  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    inMemoryState = { ...defaultState(), ...JSON.parse(raw) };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    inMemoryState = defaultState();
    await persistState();
  }

  inMemoryState.dropbox = { ...defaultState().dropbox, ...inMemoryState.dropbox };
  inMemoryState.r2 = { ...defaultState().r2, ...inMemoryState.r2 };
  inMemoryState.sync = { ...defaultState().sync, ...inMemoryState.sync };
  inMemoryState.manifests ||= {};
  inMemoryState.runs ||= [];

  return inMemoryState;
}

async function persistState() {
  await fs.writeFile(STATE_PATH, JSON.stringify(inMemoryState, null, 2));
}

export async function getState() {
  const state = await ensureStateLoaded();
  return structuredClone(state);
}

export async function updateState(mutator) {
  const state = await ensureStateLoaded();
  await mutator(state);
  state.runs = state.runs.slice(0, RUNS_LIMIT);
  await persistState();
  return structuredClone(state);
}

export async function appendRun(run) {
  return updateState((state) => {
    state.runs.unshift(run);
  });
}
