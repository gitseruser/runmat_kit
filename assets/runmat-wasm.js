const SEP_PATTERN = /[\\/]+/;

function normalizePath(input) {
  if (!input) {
    return "/";
  }
  const parts = input.split(SEP_PATTERN);
  const stack = [];
  const absolute = input.startsWith("/");
  for (const raw of parts) {
    const part = raw.trim();
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (stack.length > 0) {
        stack.pop();
      }
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join("/");
  if (absolute) {
    return "/" + joined;
  }
  return joined || ".";
}

function dirname(path) {
  const normalized = normalizePath(path);
  if (normalized === "/" || normalized === ".") {
    return normalized === "." ? "." : "/";
  }
  const parts = normalized.split("/");
  parts.pop();
  if (parts.length === 0) {
    return "/";
  }
  return "/" + parts.join("/");
}

function basename(path) {
  const normalized = normalizePath(path);
  if (normalized === "/" || normalized === ".") {
    return normalized;
  }
  const parts = normalized.split("/");
  return parts[parts.length - 1];
}

function isSubPath(target, potentialParent) {
  const normalizedTarget = normalizePath(target);
  const normalizedParent = normalizePath(potentialParent);
  if (normalizedParent === "/" || normalizedParent === ".") {
    return normalizedTarget !== normalizedParent;
  }
  return normalizedTarget.startsWith(normalizedParent.endsWith("/") ? normalizedParent : normalizedParent + "/");
}
class MemoryVolume {
  opts;
  entries = /* @__PURE__ */ new Map();
  now;
  encoder = new TextEncoder();
  constructor(opts = {}) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.entries.set("/", this.makeDirEntry());
    if (opts.initialFiles) {
      for (const [path, value] of Object.entries(opts.initialFiles)) {
        this.writeFile(path, this.coerceBuffer(value));
      }
    }
  }
  createProvider(onMutate) {
    return new MemoryProvider(this, onMutate);
  }
  serialize() {
    const items = [];
    for (const [path, entry] of this.entries.entries()) {
      if (entry.kind === "file") {
        items.push({
          path,
          kind: "file",
          data: entry.data.slice(),
          readonly: entry.readonly,
          modified: entry.modified
        });
      } else {
        items.push({
          path,
          kind: "dir",
          readonly: entry.readonly,
          modified: entry.modified,
          children: Array.from(entry.children)
        });
      }
    }
    return items;
  }
  load(entries) {
    this.entries.clear();
    this.entries.set("/", this.makeDirEntry());
    entries.slice().sort((a, b) => depth(a.path) - depth(b.path)).forEach((snapshot) => {
      const path = snapshot.path;
      const entryKind = snapshot.kind;
      if (normalizeAbsolute(path) === "/") {
        const root = this.entries.get("/");
        root.readonly = snapshot.readonly;
        root.modified = snapshot.modified;
        root.children = new Set(snapshot.children ?? []);
        return;
      }
      if (entryKind === "dir") {
        this.createDir(path, false, snapshot.readonly, snapshot.modified);
      } else {
        if (!snapshot.data) {
          throw new Error(`Snapshot missing data for file ${path}`);
        }
        this.writeFile(path, snapshot.data.slice(), snapshot.readonly, snapshot.modified);
      }
    });
  }
  readFile(path) {
    const file = this.getFile(path);
    return file.data.slice();
  }
  readMany(paths) {
    return paths.map((path) => {
      try {
        return this.readFile(path);
      } catch {
        return null;
      }
    });
  }
  writeFile(path, data, readonly = false, modified) {
    const normalized = normalizeAbsolute(path);
    const parent = this.getDir(dirname(normalized));
    const existing = this.entries.get(normalized);
    const timestamp = modified ?? this.now();
    if (existing) {
      if (existing.kind !== "file") {
        throw new Error(`Path ${normalized} is a directory`);
      }
      if (existing.readonly && !readonly) {
        throw new Error(`Path ${normalized} is readonly`);
      }
      existing.data = data.slice();
      existing.modified = timestamp;
      existing.readonly = readonly;
    } else {
      parent.children.add(basename(normalized));
      this.entries.set(normalized, {
        kind: "file",
        data: data.slice(),
        readonly,
        modified: timestamp
      });
    }
  }
  removeFile(path) {
    const normalized = normalizeAbsolute(path);
    const entry = this.entries.get(normalized);
    if (!entry) {
      throw new Error(`File not found: ${normalized}`);
    }
    if (entry.kind !== "file") {
      throw new Error(`Path ${normalized} is not a file`);
    }
    if (entry.readonly) {
      throw new Error(`File is readonly: ${normalized}`);
    }
    this.entries.delete(normalized);
    const parent = this.getDir(dirname(normalized));
    parent.children.delete(basename(normalized));
  }
  metadata(path) {
    const normalized = normalizeAbsolute(path);
    const entry = this.entries.get(normalized);
    if (!entry) {
      throw new Error(`Path not found: ${normalized}`);
    }
    if (entry.kind === "file") {
      return {
        fileType: "file",
        len: entry.data.length,
        modified: entry.modified,
        readonly: entry.readonly
      };
    }
    return {
      fileType: "dir",
      len: 0,
      modified: entry.modified,
      readonly: entry.readonly
    };
  }
  readDir(path) {
    const dir = this.getDir(path);
    const normalized = normalizeAbsolute(path);
    return Array.from(dir.children).sort().map((name) => {
      const childPath = normalized === "/" ? `/${name}` : `${normalized}/${name}`;
      const entry = this.entries.get(childPath);
      const fileType = entry?.kind === "dir" ? "dir" : entry?.kind === "file" ? "file" : "unknown";
      return {
        path: childPath,
        fileName: name,
        fileType
      };
    });
  }
  canonicalize(path) {
    return normalizeAbsolute(path);
  }
  createDir(path, failOnExists = true, readonly = false, modified) {
    const normalized = normalizeAbsolute(path);
    if (this.entries.has(normalized)) {
      if (failOnExists) {
        throw new Error(`Path already exists: ${normalized}`);
      }
      const existing = this.entries.get(normalized);
      if (existing?.kind !== "dir") {
        throw new Error(`File exists at ${normalized}`);
      }
      return false;
    }
    const parent = this.getDir(dirname(normalized));
    parent.children.add(basename(normalized));
    this.entries.set(normalized, {
      kind: "dir",
      children: /* @__PURE__ */ new Set(),
      readonly,
      modified: modified ?? this.now()
    });
    return true;
  }
  createDirAll(path) {
    const normalized = normalizeAbsolute(path);
    if (normalized === "/") {
      return false;
    }
    const parts = normalized.split("/").filter(Boolean);
    let current = "";
    let changed = false;
    for (const part of parts) {
      current = `${current}/${part}`;
      if (!this.entries.has(current)) {
        this.createDir(current, false);
        changed = true;
      }
    }
    return changed;
  }
  removeDir(path) {
    const normalized = normalizeAbsolute(path);
    if (normalized === "/") {
      throw new Error("Cannot remove root directory");
    }
    const dir = this.getDir(normalized);
    if (dir.readonly) {
      throw new Error(`Directory is readonly: ${normalized}`);
    }
    if (dir.children.size > 0) {
      throw new Error(`Directory not empty: ${normalized}`);
    }
    this.entries.delete(normalized);
    const parent = this.getDir(dirname(normalized));
    parent.children.delete(basename(normalized));
  }
  removeDirAll(path) {
    const normalized = normalizeAbsolute(path);
    if (normalized === "/") {
      throw new Error("Cannot remove root directory");
    }
    const targets = Array.from(this.entries.keys()).filter((entryPath) => entryPath === normalized || entryPath.startsWith(`${normalized}/`)).sort((a, b) => depth(b) - depth(a));
    for (const entryPath of targets) {
      const entry = this.entries.get(entryPath);
      if (!entry) {
        continue;
      }
      if (entry.kind === "dir" && entry.readonly) {
        throw new Error(`Directory is readonly: ${entryPath}`);
      }
      if (entry.kind === "file" && entry.readonly) {
        throw new Error(`File is readonly: ${entryPath}`);
      }
      this.entries.delete(entryPath);
      if (entryPath !== normalized) {
        const parentPath = dirname(entryPath);
        const parent2 = this.entries.get(parentPath);
        if (parent2?.kind === "dir") {
          parent2.children.delete(basename(entryPath));
        }
      }
    }
    const parent = this.getDir(dirname(normalized));
    parent.children.delete(basename(normalized));
  }
  rename(from, to) {
    const src = normalizeAbsolute(from);
    const dst = normalizeAbsolute(to);
    if (src === dst) {
      return;
    }
    const entry = this.entries.get(src);
    if (!entry) {
      throw new Error(`Path not found: ${src}`);
    }
    if (entry.readonly) {
      throw new Error(`Path is readonly: ${src}`);
    }
    if (this.entries.has(dst)) {
      throw new Error(`Destination exists: ${dst}`);
    }
    if (entry.kind === "dir" && isSubPath(dst, src)) {
      throw new Error("Cannot move directory into its own subtree");
    }
    const parentFrom = this.getDir(dirname(src));
    const parentTo = this.getDir(dirname(dst));
    parentFrom.children.delete(basename(src));
    parentTo.children.add(basename(dst));
    const updates = [];
    for (const key of this.entries.keys()) {
      if (key === src || key.startsWith(`${src}/`)) {
        const suffix = key.slice(src.length);
        updates.push({
          oldPath: key,
          newPath: `${dst}${suffix}`
        });
      }
    }
    updates.sort((a, b) => depth(a.oldPath) - depth(b.oldPath));
    for (const {
        oldPath,
        newPath
      }
      of updates) {
      const current = this.entries.get(oldPath);
      if (!current) {
        continue;
      }
      this.entries.delete(oldPath);
      this.entries.set(newPath, current);
    }
  }
  setReadonly(path, readonly) {
    const normalized = normalizeAbsolute(path);
    const entry = this.entries.get(normalized);
    if (!entry) {
      throw new Error(`Path not found: ${normalized}`);
    }
    entry.readonly = readonly;
    entry.modified = this.now();
  }
  coerceBuffer(value) {
    if (typeof value === "string") {
      return this.encoder.encode(value);
    }
    if (value instanceof Uint8Array) {
      return value.slice();
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value.slice(0));
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    throw new Error("Unsupported buffer type");
  }
  getFile(path) {
    const normalized = normalizeAbsolute(path);
    const entry = this.entries.get(normalized);
    if (!entry || entry.kind !== "file") {
      throw new Error(`File not found: ${normalized}`);
    }
    return entry;
  }
  getDir(path) {
    const normalized = normalizeAbsolute(path);
    const entry = this.entries.get(normalized);
    if (!entry) {
      throw new Error(`Directory not found: ${normalized}`);
    }
    if (entry.kind !== "dir") {
      throw new Error(`Path is not a directory: ${normalized}`);
    }
    return entry;
  }
  makeDirEntry() {
    return {
      kind: "dir",
      children: /* @__PURE__ */ new Set(),
      readonly: false,
      modified: this.now()
    };
  }
}
class MemoryProvider {
  volume;
  onMutate;
  constructor(volume, onMutate) {
    this.volume = volume;
    this.onMutate = onMutate;
  }
  readFile(path) {
    return this.volume.readFile(path);
  }
  readMany(paths) {
    return this.volume.readMany(paths);
  }
  writeFile(path, data) {
    this.volume.writeFile(path, coerce(data));
    this.onMutate?.();
  }
  removeFile(path) {
    this.volume.removeFile(path);
    this.onMutate?.();
  }
  metadata(path) {
    return this.volume.metadata(path);
  }
  symlinkMetadata(path) {
    return this.volume.metadata(path);
  }
  readDir(path) {
    return this.volume.readDir(path);
  }
  canonicalize(path) {
    return this.volume.canonicalize(path);
  }
  createDir(path) {
    const changed = this.volume.createDir(path);
    if (changed) {
      this.onMutate?.();
    }
  }
  createDirAll(path) {
    const changed = this.volume.createDirAll(path);
    if (changed) {
      this.onMutate?.();
    }
  }
  removeDir(path) {
    this.volume.removeDir(path);
    this.onMutate?.();
  }
  removeDirAll(path) {
    this.volume.removeDirAll(path);
    this.onMutate?.();
  }
  rename(from, to) {
    this.volume.rename(from, to);
    this.onMutate?.();
  }
  setReadonly(path, readonly) {
    this.volume.setReadonly(path, readonly);
    this.onMutate?.();
  }
}

function createInMemoryFsProvider(options) {
  const volume = new MemoryVolume(options);
  return volume.createProvider();
}

function coerce(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  throw new Error("Unsupported buffer type");
}

function normalizeAbsolute(path) {
  const normalized = normalizePath(path);
  if (!normalized.startsWith("/")) {
    return normalized === "." ? "/" : `/${normalized}`;
  }
  return normalized === "" ? "/" : normalized;
}

function depth(path) {
  if (path === "/" || path === ".") {
    return 0;
  }
  return normalizeAbsolute(path).split("/").filter(Boolean).length;
}
const DEFAULT_DB_NAME = "runmat-fs";
const DEFAULT_STORE_NAME = "entries";
const SHARED_BACKINGS_SYMBOL = Symbol.for("runmat.fs.indexedDbBackings");

function sharedBackings() {
  const globalState = globalThis;
  if (!globalState[SHARED_BACKINGS_SYMBOL]) {
    globalState[SHARED_BACKINGS_SYMBOL] = /* @__PURE__ */ new Map();
  }
  return globalState[SHARED_BACKINGS_SYMBOL];
}
async function createIndexedDbFsHandle(options = {}) {
  const idb = getIndexedDb();
  const dbName = options.dbName ?? DEFAULT_DB_NAME;
  const storeName = options.storeName ?? DEFAULT_STORE_NAME;
  const version = options.version ?? 1;
  const key = sharedBackingKey(dbName, storeName, version);
  const backingOptions = normalizeSharedBackingOptions(options);
  const backings = sharedBackings();
  let backingPromise = backings.get(key);
  if (!backingPromise) {
    backingPromise = createSharedBacking(idb, dbName, storeName, version, backingOptions).catch((error) => {
      backings.delete(key);
      throw error;
    });
    backings.set(key, backingPromise);
  }
  const backing = await backingPromise;
  assertSharedBackingOptions(key, backing.options, backingOptions);
  backing.refCount += 1;
  return new IndexedDbHandle(key, backing);
}
async function createIndexedDbFsProvider(options) {
  const handle = await createIndexedDbFsHandle(options);
  return handle.provider;
}
class IndexedDbHandle {
  key;
  backing;
  provider;
  closed = false;
  constructor(key, backing) {
    this.key = key;
    this.backing = backing;
    this.provider = backing.volume.createProvider(() => this.onMutate());
  }
  async flush() {
    if (this.backing.closed) {
      return;
    }
    if (this.backing.flushTimer) {
      clearTimeout(this.backing.flushTimer);
      this.backing.flushTimer = null;
    }
    this.queueFlush();
    if (this.backing.pendingFlush) {
      await this.backing.pendingFlush;
    }
  }
  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.backing.closed) {
      return;
    }
    this.backing.refCount = Math.max(0, this.backing.refCount - 1);
    if (this.backing.refCount > 0) {
      return;
    }
    if (this.backing.flushTimer) {
      clearTimeout(this.backing.flushTimer);
      this.backing.flushTimer = null;
    }
    this.backing.closed = true;
    this.backing.db.close();
    sharedBackings().delete(this.key);
  }
  scheduleFlush() {
    if (this.backing.closed) {
      return;
    }
    if (this.backing.flushDebounceMs === 0) {
      this.queueFlush();
      return;
    }
    if (this.backing.flushTimer) {
      clearTimeout(this.backing.flushTimer);
    }
    this.backing.flushTimer = setTimeout(() => {
      this.backing.flushTimer = null;
      this.queueFlush();
    }, this.backing.flushDebounceMs);
  }
  queueFlush() {
    if (this.backing.closed || this.backing.pendingFlush) {
      return;
    }
    this.backing.pendingFlush = this.persistAll().finally(() => {
      this.backing.pendingFlush = null;
      if (this.backing.dirty) {
        this.queueFlush();
      }
    });
  }
  onMutate() {
    this.backing.dirty = true;
    this.scheduleFlush();
  }
  async persistAll() {
    while (!this.backing.closed) {
      this.backing.dirty = false;
      const snapshot = this.backing.volume.serialize();
      await writeAllEntries(this.backing.db, this.backing.storeName, snapshot);
      if (!this.backing.dirty) {
        break;
      }
    }
  }
}
async function createSharedBacking(idb, dbName, storeName, version, options) {
  const db = await openDatabase(idb, dbName, storeName, version);
  const snapshot = await readAllEntries(db, storeName);
  const volume = new MemoryVolume({
    now: options.now ?? void 0
  });
  volume.load(snapshot);
  return {
    db,
    storeName,
    volume,
    flushDebounceMs: options.flushDebounceMs,
    options,
    refCount: 0,
    pendingFlush: null,
    flushTimer: null,
    closed: false,
    dirty: false
  };
}

function normalizeSharedBackingOptions(options) {
  return {
    flushDebounceMs: options.flushDebounceMs ?? 25,
    now: options.now ?? null
  };
}

function assertSharedBackingOptions(key, active, requested) {
  const mismatches = [];
  if (active.flushDebounceMs !== requested.flushDebounceMs) {
    mismatches.push("flushDebounceMs");
  }
  if (active.now !== requested.now) {
    mismatches.push("now");
  }
  if (mismatches.length === 0) {
    return;
  }
  throw new Error(`IndexedDB filesystem backing '${key}' is already open with different ${mismatches.join(" and ")}; close existing handles before opening it with different persistence options`);
}

function sharedBackingKey(dbName, storeName, version) {
  return `${dbName}\0${storeName}\0${version}`;
}

function getIndexedDb() {
  if (typeof indexedDB === "undefined") {
    throw new Error("indexedDB API is unavailable in this environment");
  }
  return indexedDB;
}

function openDatabase(idb, dbName, storeName, version) {
  return new Promise((resolve, reject) => {
    const request = idb.open(dbName, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, {
          keyPath: "path"
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB database"));
    request.onblocked = () => reject(new Error("IndexedDB upgrade was blocked by another connection"));
  });
}

function readAllEntries(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const getAll = store.getAll?.bind(store);
    if (typeof getAll === "function") {
      const request = getAll();
      request.onsuccess = () => {
        const raw = request.result ?? [];
        resolve(raw.map(deserializeEntry));
      };
      request.onerror = () => reject(request.error ?? new Error("Failed to read IndexedDB entries"));
      return;
    }
    const entries = [];
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const result = cursor.result;
      if (!result) {
        resolve(entries.map(deserializeEntry));
        return;
      }
      entries.push(result.value);
      result.continue();
    };
    cursor.onerror = () => reject(cursor.error ?? new Error("Failed to iterate IndexedDB cursor"));
  });
}

function writeAllEntries(db, storeName, entries) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const clearReq = store.clear();
    clearReq.onerror = () => reject(clearReq.error ?? new Error("Failed to clear IndexedDB store before write"));
    clearReq.onsuccess = () => {
      for (const entry of entries) {
        const record = {
          path: entry.path,
          kind: entry.kind,
          readonly: entry.readonly,
          modified: entry.modified,
          children: entry.children ?? []
        };
        if (entry.kind === "file" && entry.data) {
          record.data = entry.data.slice().buffer;
        }
        store.put(record);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to persist IndexedDB entries"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
  });
}

function deserializeEntry(entry) {
  return {
    path: entry.path,
    kind: entry.kind,
    readonly: entry.readonly,
    modified: entry.modified,
    children: entry.children,
    data: entry.data ? new Uint8Array(entry.data.slice(0)) : void 0
  };
}
const DEFAULT_PROVIDER_SYMBOL = Symbol.for("runmat.fs.defaultProvider");
async function createDefaultFsProvider() {
  const globalState = globalThis;
  if (!globalState[DEFAULT_PROVIDER_SYMBOL]) {
    globalState[DEFAULT_PROVIDER_SYMBOL] = createDefaultFsProviderUncached().catch((error) => {
      delete globalState[DEFAULT_PROVIDER_SYMBOL];
      throw error;
    });
  }
  return globalState[DEFAULT_PROVIDER_SYMBOL];
}
async function createDefaultFsProviderUncached() {
  if (supportsIndexedDb()) {
    try {
      return await createIndexedDbFsProvider();
    } catch (error) {
      console.warn("[runmat] Failed to init IndexedDB provider, falling back to in-memory.", error);
    }
  }
  return createInMemoryFsProvider();
}

function supportsIndexedDb() {
  return typeof indexedDB !== "undefined" && typeof IDBDatabase !== "undefined";
}
class WorkspaceMetadataStore {
  entries = /* @__PURE__ */ new Map();
  version = 0;
  materializedByToken = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  applySnapshot(snapshot) {
    if (snapshot.full || snapshot.version > this.version) {
      if (snapshot.full) {
        this.entries.clear();
        this.materializedByToken.clear();
        this.pending.clear();
      }
      this.version = snapshot.version;
    }
    for (const value of snapshot.values) {
      const existing = this.entries.get(value.name);
      if (existing?.entry.previewToken && existing.entry.previewToken !== value.previewToken) {
        this.materializedByToken.delete(existing.entry.previewToken);
        this.pending.delete(existing.entry.previewToken);
      }
      if (!value.previewToken) {
        this.materializedByToken.delete(value.name);
        this.pending.delete(value.name);
      }
      this.entries.set(value.name, {
        entry: value
      });
    }
  }
  getEntry(name) {
    return this.entries.get(name)?.entry;
  }
  clear() {
    this.entries.clear();
    this.materializedByToken.clear();
    this.pending.clear();
  }
  async ensureMaterialized(entry, session, previewLimit) {
    const token = entry.previewToken ?? entry.name;
    const cached = this.materializedByToken.get(token);
    if (cached) {
      return cached.value;
    }
    const pending = this.pending.get(token);
    if (pending) {
      return pending;
    }
    const selector = entry.previewToken ? {
      previewToken: entry.previewToken
    } : {
      name: entry.name
    };
    const resolver = session.materializeVariable(selector, previewLimit ? {
      limit: previewLimit
    } : void 0).then((value) => {
      if (value) {
        this.materializedByToken.set(token, {
          token: entry.previewToken,
          name: entry.name,
          value
        });
      }
      this.pending.delete(token);
      return value;
    }).catch(() => {
      this.pending.delete(token);
      return void 0;
    });
    this.pending.set(token, resolver);
    return resolver;
  }
}

function formatShape(shape) {
  if (!shape.length) {
    return "1Г—1";
  }
  return shape.join("Г—");
}

function formatBytes(size) {
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatPreview(values, truncated) {
  const formatted = values.slice(0, 8).map((value) => formatNumber(value));
  const suffix = truncated || values.length > 8 ? " вЂ¦" : "";
  return `[${formatted.join(", ")}${suffix}]`;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return value.toString();
  }
  if (Math.abs(value) >= 1 || value === 0) {
    return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }
  return value.toExponential(2);
}
const __internals$1 = {
  WorkspaceMetadataStore,
  formatShape,
  formatBytes,
  formatPreview,
  formatNumber
};
let installed = false;

function installWebGpuCompatibilityShims() {
  if (installed) {
    return;
  }
  installed = true;
  if (typeof navigator === "undefined") {
    return;
  }
  const gpu = navigator.gpu;
  if (!gpu || typeof gpu.requestAdapter !== "function") {
    return;
  }
  const originalRequestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async function(...args) {
    const adapter = await originalRequestAdapter(...args);
    if (adapter && typeof adapter.requestDevice === "function" && !adapter.__runmatShimmed) {
      shimAdapter(adapter);
    }
    return adapter;
  };
}

function shimAdapter(adapter) {
  const originalRequestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = function(descriptor) {
    const patched = patchDeviceDescriptor(descriptor);
    return originalRequestDevice(patched);
  };
  Object.defineProperty(adapter, "__runmatShimmed", {
    value: true,
    configurable: true,
    enumerable: false,
    writable: false
  });
}

function patchDeviceDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object") {
    return descriptor;
  }
  const requiredLimits = cloneLimits(descriptor.requiredLimits);
  if (!requiredLimits) {
    return descriptor;
  }
  if (typeof requiredLimits.maxInterStageShaderComponents === "number" && typeof requiredLimits.maxInterStageShaderVariables === "undefined") {
    requiredLimits.maxInterStageShaderVariables = requiredLimits.maxInterStageShaderComponents;
    delete requiredLimits.maxInterStageShaderComponents;
    return {
      ...descriptor,
      requiredLimits
    };
  }
  return descriptor;
}

function cloneLimits(limits) {
  if (!limits || typeof limits !== "object") {
    return null;
  }
  return {
    ...limits
  };
}
class RunMatExecutionError extends Error {
  kind;
  identifier;
  diagnostic;
  span;
  callstack;
  callstackElided;
  constructor(details) {
    super(details.message);
    this.name = "RunMatExecutionError";
    this.kind = details.kind;
    this.identifier = details.identifier;
    this.diagnostic = details.diagnostic;
    this.span = details.span;
    this.callstack = details.callstack;
    this.callstackElided = details.callstackElided;
  }
}
let loadPromise = null;
let nativeModuleOverride = null;
async function loadNativeModule(wasmModule) {
  installWebGpuCompatibilityShims();
  if (nativeModuleOverride) {
    if (isNativeSession(nativeModuleOverride)) {
      return {
        default: async () => {},
        initRunMat: async () => nativeModuleOverride
      };
    }
    return nativeModuleOverride;
  }
  if (!loadPromise) {
    loadPromise = (async () => {
      const wasmModuleUrl = new URL("./pkg/runmat_wasm.js", import.meta.url);
      const native = await import(wasmModuleUrl.href);
      if (typeof native.default === "function") {
        await native.default(wasmModule);
      }
      return native;
    })();
  }
  return loadPromise;
}
async function initRunMat$1(options = {}) {
  const native = await loadNativeModule(options.wasmModule);
  const fsProvider = await resolveFsProvider(options.fsProvider);
  if (options.plotCanvas) {
    if (typeof native.createPlotSurface === "function") {
      await native.createPlotSurface(options.plotCanvas);
    } else {
      const err = new Error("The loaded runmat-wasm module does not support WebGPU plotting surfaces yet.");
      err.code = "PlotCanvas";
      throw err;
    }
  }
  const supportsWebGpu = typeof navigator !== "undefined" && typeof navigator.gpu !== "undefined";
  const hasExplicitEnableFlag = Object.prototype.hasOwnProperty.call(options, "enableGpu");
  const requestedGpu = options.enableGpu ?? true;
  let effectiveEnableGpu;
  if (hasExplicitEnableFlag) {
    if (requestedGpu && !supportsWebGpu) {
      console.warn("[runmat] GPU acceleration was explicitly requested, but WebGPU APIs are unavailable in this context.");
      effectiveEnableGpu = false;
    } else {
      effectiveEnableGpu = requestedGpu;
    }
  } else {
    effectiveEnableGpu = requestedGpu && supportsWebGpu;
    if (requestedGpu && !supportsWebGpu) {
      console.warn("[runmat] WebGPU is not available in this environment; falling back to CPU execution.");
    }
  }
  const session = await native.initRunMat({
    enableGpu: effectiveEnableGpu,
    enableJit: options.enableJit ?? false,
    verbose: options.verbose ?? false,
    logLevel: options.logLevel,
    gpuBufferPoolMaxPerKey: options.gpuBufferPoolMaxPerKey,
    telemetryConsent: options.telemetryConsent ?? true,
    telemetryId: options.telemetryId,
    telemetryRunKind: options.telemetryRunKind,
    telemetryEmitter: options.telemetryEmitter,
    wgpuPowerPreference: options.wgpuPowerPreference ?? "auto",
    wgpuForceFallbackAdapter: options.wgpuForceFallbackAdapter ?? false,
    scatterTargetPoints: options.scatterTargetPoints,
    surfaceVertexBudget: options.surfaceVertexBudget,
    emitFusionPlan: options.emitFusionPlan ?? false,
    callstackLimit: options.callstackLimit,
    errorNamespace: options.errorNamespace,
    languageCompat: options.language?.compat,
    fsProvider
  });
  return new WebRunMatSession(session);
}
async function subscribeStdout$1(listener) {
  const native = await loadNativeModule();
  requireNativeFunction(native, "subscribeStdout");
  return native.subscribeStdout((entry) => listener(entry));
}
async function unsubscribeStdout$1(id) {
  const native = await loadNativeModule();
  requireNativeFunction(native, "unsubscribeStdout");
  native.unsubscribeStdout(id);
}
async function closeFigure$1(handle) {
  const native = await loadNativeModule();
  requireNativeFunction(native, "closeFigure");
  try {
    return native.closeFigure(handle ?? null);
  } catch (error) {
    throw coerceFigureError(error);
  }
}
async function renderFigureImage$1(options = {}) {
  const native = await loadNativeModule();
  requireNativeFunction(native, "renderFigureImage");
  const handle = typeof options.handle === "number" ? options.handle : null;
  const width = options.width ?? 0;
  const height = options.height ?? 0;
  const hasTextmark = typeof options.textmark === "string";
  const textmark = hasTextmark ? options.textmark : void 0;
  try {
    let bytes;
    if (options.cameraState) {
      if (typeof native.renderFigureImageWithCameraState !== "function") {
        throw new Error("The loaded runmat-wasm module does not support renderFigureImageWithCameraState yet.");
      }
      bytes = await native.renderFigureImageWithCameraState(handle, width, height, options.cameraState, textmark);
    } else if (hasTextmark && typeof native.renderFigureImageWithTextmark === "function") {
      bytes = await native.renderFigureImageWithTextmark(handle, width, height, textmark);
    } else {
      bytes = await native.renderFigureImage(handle, width, height);
    }
    if (bytes instanceof Uint8Array) {
      return bytes;
    }
    return new Uint8Array(bytes ?? []);
  } catch (error) {
    throw coerceFigureError(error);
  }
}
class WebRunMatSession {
  native;
  disposed = false;
  constructor(native) {
    this.native = native;
  }
  ensureActive() {
    if (this.disposed) {
      throw new Error("RunMat session has been disposed");
    }
  }
  async executeRequest(request) {
    this.ensureActive();
    try {
      return await this.native.executeRequest(request);
    } catch (error) {
      throw coerceRunMatError(error);
    }
  }
  async resetSession() {
    this.ensureActive();
    this.native.resetSession();
  }
  async stats() {
    this.ensureActive();
    return this.native.stats();
  }
  clearWorkspace() {
    this.ensureActive();
    this.native.clearWorkspace();
  }
  async exportWorkspaceState(options = {}) {
    this.ensureActive();
    if (typeof this.native.exportWorkspaceState !== "function") {
      return null;
    }
    const mode = options.includeVariables ?? "auto";
    const state = await this.native.exportWorkspaceState(mode);
    return state ?? null;
  }
  async importWorkspaceState(state) {
    this.ensureActive();
    if (typeof this.native.importWorkspaceState !== "function") {
      return false;
    }
    try {
      return this.native.importWorkspaceState(state) === true;
    } catch {
      return false;
    }
  }
  async workspaceSnapshot() {
    this.ensureActive();
    requireNativeFunction(this.native, "workspaceSnapshot");
    return this.native.workspaceSnapshot();
  }
  async inspectDataFile(path) {
    this.ensureActive();
    if (typeof this.native.inspectDataFile !== "function") {
      throw new Error("The loaded runmat-wasm module does not expose inspectDataFile yet.");
    }
    const entries = await this.native.inspectDataFile(path);
    return Array.isArray(entries) ? entries : [];
  }
  async previewGeometry(path, budget) {
    this.ensureActive();
    if (typeof this.native.previewGeometry !== "function") {
      throw new Error("The loaded runmat-wasm module does not expose previewGeometry yet.");
    }
    return this.native.previewGeometry(path, budget ?? null);
  }
  async disposeGeometryPreview(figureHandle, geometrySceneHandle) {
    this.ensureActive();
    if (typeof this.native.disposeGeometryPreview !== "function") {
      if (typeof figureHandle === "number") {
        await closeFigure$1(figureHandle);
      }
      return;
    }
    await this.native.disposeGeometryPreview(typeof figureHandle === "number" ? figureHandle : null, typeof geometrySceneHandle === "number" ? geometrySceneHandle : null);
  }
  async feaCapabilities() {
    this.ensureActive();
    if (typeof this.native.feaCapabilities !== "function") {
      throw new Error("The loaded runmat-wasm module does not expose feaCapabilities yet.");
    }
    return this.native.feaCapabilities();
  }
  async checkFeaStudy(path) {
    this.ensureActive();
    if (typeof this.native.checkFeaStudy !== "function") {
      throw new Error("The loaded runmat-wasm module does not expose checkFeaStudy yet.");
    }
    return this.native.checkFeaStudy(path);
  }
  async applyFeaStudyDocumentOperation(operation, path, source, input) {
    this.ensureActive();
    if (typeof this.native.applyFeaStudyDocumentOperation !== "function") {
      throw new Error("The loaded runmat-wasm module does not expose applyFeaStudyDocumentOperation yet.");
    }
    return this.native.applyFeaStudyDocumentOperation(operation, path, source, input);
  }
  async runFeaStudy(path, artifactRoot) {
    this.ensureActive();
    if (typeof this.native.runFeaStudy !== "function") {
      throw new Error("The loaded runmat-wasm module does not expose runFeaStudy yet.");
    }
    return this.native.runFeaStudy(path, artifactRoot ?? null);
  }
  async feaField(runId, fieldId, options) {
    this.ensureActive();
    if (typeof this.native.feaField !== "function") {
      throw new Error("The loaded runmat-wasm module does not expose feaField yet.");
    }
    return this.native.feaField(runId, fieldId, options);
  }
  async materializeDataFileVariable(path, selector, options) {
    this.ensureActive();
    if (typeof this.native.materializeDataFileVariable !== "function") {
      throw new Error("The loaded runmat-wasm module does not expose materializeDataFileVariable yet.");
    }
    const normalized = normalizeMaterializeSelector(selector);
    const arrayName = typeof normalized === "string" ? normalized : normalized.name ?? normalized.previewToken;
    if (!arrayName) {
      throw new Error("materializeDataFileVariable selector requires name");
    }
    const wireOptions = normalizeMaterializeOptions(options);
    return this.native.materializeDataFileVariable(path, arrayName, wireOptions);
  }
  async exportFigureScene(handle) {
    this.ensureActive();
    if (typeof this.native.exportFigureScene !== "function") {
      return null;
    }
    try {
      return await this.native.exportFigureScene(handle) ?? null;
    } catch (error) {
      throw coerceFigureError(error);
    }
  }
  async exportGeometryScene(handle) {
    this.ensureActive();
    if (typeof this.native.exportGeometryScene !== "function") {
      return null;
    }
    try {
      return this.native.exportGeometryScene(handle) ?? null;
    } catch {
      return null;
    }
  }
  async importFigureScene(scene) {
    this.ensureActive();
    if (typeof this.native.importFigureScene !== "function") {
      return null;
    }
    try {
      const handle = await this.native.importFigureScene(scene);
      return typeof handle === "number" ? handle : null;
    } catch (error) {
      throw coerceFigureError(error);
    }
  }
  async importGeometryScene(scene) {
    this.ensureActive();
    if (typeof this.native.importGeometryScene !== "function") {
      return null;
    }
    try {
      const handle = await this.native.importGeometryScene(scene);
      return typeof handle === "number" ? handle : null;
    } catch {
      return null;
    }
  }
  async importFigureSceneFromPath(path) {
    this.ensureActive();
    if (typeof this.native.importFigureSceneFromPath !== "function") {
      return null;
    }
    try {
      const handle = await this.native.importFigureSceneFromPath(path);
      return typeof handle === "number" ? handle : null;
    } catch (error) {
      throw coerceFigureError(error);
    }
  }
  async currentFigureHandle() {
    this.ensureActive();
    requireNativeFunction(this.native, "currentFigureHandle");
    return this.native.currentFigureHandle();
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    if (typeof this.native.dispose === "function") {
      this.native.dispose();
    }
    this.disposed = true;
  }
  telemetryConsent() {
    this.ensureActive();
    return this.native.telemetryConsent();
  }
  telemetryClientId() {
    this.ensureActive();
    if (typeof this.native.telemetryClientId !== "function") {
      return void 0;
    }
    return this.native.telemetryClientId() ?? void 0;
  }
  async memoryUsage() {
    this.ensureActive();
    if (typeof this.native.memoryUsage !== "function") {
      return {
        bytes: 0,
        pages: 0
      };
    }
    return this.native.memoryUsage();
  }
  gpuStatus() {
    this.ensureActive();
    return this.native.gpuStatus();
  }
  cancelExecution() {
    if (this.disposed) {
      return;
    }
    if (typeof this.native.cancelExecution === "function") {
      this.native.cancelExecution();
    }
  }
  async setInputHandler(handler) {
    this.ensureActive();
    if (typeof this.native.setInputHandler !== "function") {
      throw new Error("The loaded runmat-wasm module does not expose setInputHandler yet.");
    }
    this.native.setInputHandler(handler ? (request) => handler(request) : null);
  }
  async setStepHandler(handler) {
    this.ensureActive();
    if (typeof this.native.setStepHandler !== "function") {
      throw new Error("The loaded runmat-wasm module does not expose setStepHandler yet.");
    }
    this.native.setStepHandler(handler ? (request) => handler(request) : null);
  }
  async materializeVariable(selector, options) {
    this.ensureActive();
    requireNativeFunction(this.native, "materializeVariable");
    const wireSelector = normalizeMaterializeSelector(selector);
    const wireOptions = normalizeMaterializeOptions(options);
    return this.native.materializeVariable(wireSelector, wireOptions);
  }
  setFusionPlanEnabled(enabled) {
    this.ensureActive();
    requireNativeFunction(this.native, "setFusionPlanEnabled");
    this.native.setFusionPlanEnabled(enabled);
  }
  setLanguageCompat(mode) {
    this.ensureActive();
    requireNativeFunction(this.native, "setLanguageCompat");
    this.native.setLanguageCompat(mode);
  }
  async fusionPlanForSource(source) {
    this.ensureActive();
    if (typeof this.native.fusionPlanForSource !== "function") {
      throw new Error("The loaded runmat-wasm module does not expose fusionPlanForSource yet.");
    }
    try {
      return this.native.fusionPlanForSource(source) ?? null;
    } catch (error) {
      throw coerceRunMatError(error);
    }
  }
  async setFsProvider(provider) {
    this.ensureActive();
    if (typeof this.native.setFsProvider !== "function") {
      throw new Error("The loaded runmat-wasm module does not expose setFsProvider yet.");
    }
    this.native.setFsProvider(provider);
  }
}

function ensureFsProvider(provider) {
  const requiredMethods = [
    "readFile",
    "writeFile",
    "removeFile",
    "metadata",
    "readDir"
  ];
  for (const method of requiredMethods) {
    if (typeof provider[method] !== "function") {
      throw new Error(`fsProvider.${String(method)} must be a function`);
    }
  }
}

function requireNativeFunction(native, method) {
  if (typeof native[method] !== "function") {
    throw new Error(`The loaded runmat-wasm module does not expose ${String(method)} yet.`);
  }
}

function isRunMatErrorPayload(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value;
  return typeof payload.kind === "string" && typeof payload.message === "string" && typeof payload.diagnostic === "string";
}

function coerceRunMatError(value) {
  if (isRunMatErrorPayload(value)) {
    return new RunMatExecutionError({
      kind: value.kind,
      message: value.message,
      identifier: value.identifier,
      diagnostic: value.diagnostic,
      span: value.span,
      callstack: value.callstack ?? [],
      callstackElided: value.callstackElided
    });
  }
  if (value instanceof RunMatExecutionError) {
    return value;
  }
  if (value instanceof Error) {
    return new RunMatExecutionError({
      kind: "runtime",
      message: value.message,
      diagnostic: value.message,
      callstack: []
    });
  }
  const message = String(value ?? "RunMat execution failed");
  return new RunMatExecutionError({
    kind: "runtime",
    message,
    diagnostic: message,
    callstack: []
  });
}

function isFigureErrorPayload(value) {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string";
}

function coerceFigureError(value) {
  if (isFigureErrorPayload(value)) {
    const err2 = new Error(value.message ?? value.code ?? "Figure error");
    err2.code = value.code ?? "Unknown";
    if (typeof value.handle === "number") {
      err2.handle = value.handle;
    }
    if (typeof value.rows === "number") {
      err2.rows = value.rows;
    }
    if (typeof value.cols === "number") {
      err2.cols = value.cols;
    }
    if (typeof value.index === "number") {
      err2.index = value.index;
    }
    if (typeof value.details === "string") {
      err2.details = value.details;
    }
    return err2;
  }
  if (value instanceof Error) {
    const err2 = value;
    if (!err2.code) {
      err2.code = "Unknown";
    }
    return err2;
  }
  const err = new Error(String(value));
  err.code = "Unknown";
  return err;
}
async function resolveFsProvider(provided) {
  if (provided) {
    ensureFsProvider(provided);
    return provided;
  }
  try {
    const autoProvider = await createDefaultFsProvider();
    ensureFsProvider(autoProvider);
    return autoProvider;
  } catch (error) {
    console.warn("[runmat] Unable to initialize default filesystem provider.", error);
    return void 0;
  }
}

function normalizeMaterializeSelector(selector) {
  if (typeof selector === "string") {
    const trimmed = selector.trim();
    if (!trimmed) {
      throw new Error("materializeVariable selector string must not be empty");
    }
    return trimmed;
  }
  if (!selector || typeof selector !== "object") {
    throw new Error("materializeVariable selector must be a string or object");
  }
  if (typeof selector.previewToken === "string" && selector.previewToken.trim()) {
    return {
      previewToken: selector.previewToken.trim()
    };
  }
  const payload = {};
  if (typeof selector.name === "string" && selector.name.trim()) {
    payload.name = selector.name.trim();
  }
  if (!payload.name) {
    throw new Error("materializeVariable selector requires name or previewToken");
  }
  return payload;
}

function normalizeMaterializeOptions(options) {
  if (!options) {
    return void 0;
  }
  const payload = {};
  if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
    const limit = Math.floor(options.limit);
    if (limit > 0) {
      payload.limit = limit;
    }
  }
  if (options.slice) {
    const start = normalizeSliceVector(options.slice.start, false);
    const shape = normalizeSliceVector(options.slice.shape, true);
    if (start && shape) {
      payload.slice = {
        start,
        shape
      };
    }
  }
  return payload;
}

function normalizeSliceVector(values, requirePositive = false) {
  if (!Array.isArray(values) || values.length === 0) {
    return void 0;
  }
  const normalized = [];
  for (const raw of values) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return void 0;
    }
    const base = Math.floor(raw);
    if (requirePositive) {
      if (base <= 0) {
        return void 0;
      }
      normalized.push(base);
    } else {
      normalized.push(Math.max(0, base));
    }
  }
  return normalized;
}

function normalizeResumeInputValue(value) {
  if (value && typeof value === "object") {
    const payload = value;
    if (payload.error) {
      return {
        error: String(payload.error)
      };
    }
    if (payload.kind === "keyPress") {
      return {
        kind: "keyPress"
      };
    }
    if (payload.kind === "line") {
      const raw = payload.value ?? payload.line ?? "";
      return {
        kind: "line",
        value: String(raw ?? "")
      };
    }
  }
  if (value === null || value === void 0) {
    return {
      kind: "line",
      value: ""
    };
  }
  return {
    kind: "line",
    value: String(value)
  };
}
const __internals = {
  coerceFigureError,
  normalizeResumeInputValue,
  workspaceHover: __internals$1,
  setNativeModuleOverride(module2) {
    nativeModuleOverride = module2;
    if (!module2) {
      loadPromise = null;
    }
  }
};

function isNativeSession(value) {
  return Boolean(value && typeof value.executeRequest === "function");
}
import * as runmatGlue from "./runmat_wasm_gpu.js";
const wasmWeb = runmatGlue;
const __wbg_init = runmatGlue.default;
export {
  __wbg_init as _,
  __internals as a,
  createDefaultFsProvider as c,
  initRunMat$1 as i,
  renderFigureImage$1 as r,
  subscribeStdout$1 as s,
  unsubscribeStdout$1 as u,
  wasmWeb as w
};
