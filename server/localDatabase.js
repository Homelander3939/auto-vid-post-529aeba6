const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'local-uploader.sqlite');
const STORAGE_DIR = path.join(DATA_DIR, 'storage');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(STORAGE_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS local_records (
    table_name TEXT NOT NULL,
    id TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (table_name, id)
  );
  CREATE INDEX IF NOT EXISTS idx_local_records_table
    ON local_records(table_name, updated_at);
`);

function runTransaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  }
}

const readRows = db.prepare('SELECT data_json FROM local_records WHERE table_name = ?');
const putRow = db.prepare(`
  INSERT INTO local_records (table_name, id, data_json, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(table_name, id) DO UPDATE SET
    data_json = excluded.data_json,
    updated_at = excluded.updated_at
`);
const removeRow = db.prepare('DELETE FROM local_records WHERE table_name = ? AND id = ?');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function getValue(row, column) {
  return String(column || '').split('.').reduce((value, key) => value?.[key], row);
}

function sameValue(left, right) {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return String(left) === String(right);
}

function parseColumns(columns) {
  if (!columns || columns === '*') return null;
  return String(columns)
    .split(',')
    .map((column) => column.trim())
    .filter((column) => column && !column.includes('('));
}

function projectRow(row, columns) {
  const selected = parseColumns(columns);
  if (!selected?.length) return clone(row);
  return Object.fromEntries(selected.map((column) => [column, clone(getValue(row, column))]));
}

function listRows(tableName) {
  return readRows.all(String(tableName)).map((item) => JSON.parse(item.data_json));
}

function saveRow(tableName, row) {
  const now = new Date().toISOString();
  const existing = row.created_at || now;
  const normalized = {
    ...clone(row),
    id: String(row.id ?? randomUUID()),
    created_at: existing,
    updated_at: row.updated_at || now,
  };
  putRow.run(String(tableName), normalized.id, JSON.stringify(normalized), existing, normalized.updated_at);
  return normalized;
}

function splitTopLevel(value) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseFilterValue(value, operator) {
  const normalized = String(value ?? '').trim();
  if (operator === 'in') {
    const inner = normalized.startsWith('(') && normalized.endsWith(')')
      ? normalized.slice(1, -1)
      : normalized;
    return splitTopLevel(inner).map((item) => parseFilterValue(item, 'eq'));
  }
  if (normalized === 'null') return null;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized);
  return normalized.replace(/^"|"$/g, '');
}

function parseOrExpression(expression) {
  return splitTopLevel(String(expression || '')).map((predicate) => {
    const firstDot = predicate.indexOf('.');
    const secondDot = firstDot < 0 ? -1 : predicate.indexOf('.', firstDot + 1);
    if (firstDot <= 0 || secondDot <= firstDot + 1) return null;
    const column = predicate.slice(0, firstDot);
    const op = predicate.slice(firstDot + 1, secondDot);
    const rawValue = predicate.slice(secondDot + 1);
    return { op, column, value: parseFilterValue(rawValue, op) };
  }).filter(Boolean);
}

function matchesFilter(row, filter) {
  if (filter.op === 'or') {
    return Array.isArray(filter.conditions)
      && filter.conditions.some((condition) => matchesFilter(row, condition));
  }
  const value = getValue(row, filter.column);
  if (filter.op === 'eq') return sameValue(value, filter.value);
  if (filter.op === 'neq') return !sameValue(value, filter.value);
  if (filter.op === 'in') return Array.isArray(filter.value) && filter.value.some((item) => sameValue(value, item));
  if (filter.op === 'is') return filter.value === null ? value === null || value === undefined : sameValue(value, filter.value);
  if (filter.op === 'lt') return value < filter.value;
  if (filter.op === 'lte') return value <= filter.value;
  if (filter.op === 'gt') return value > filter.value;
  if (filter.op === 'gte') return value >= filter.value;
  if (filter.op === 'not') {
    if (filter.operator === 'is') return filter.value === null ? value !== null && value !== undefined : !sameValue(value, filter.value);
    if (filter.operator === 'eq') return !sameValue(value, filter.value);
  }
  return true;
}

class LocalQuery {
  constructor(tableName) {
    this.tableName = String(tableName);
    this.action = 'select';
    this.payload = null;
    this.columns = '*';
    this.filters = [];
    this.orders = [];
    this.maxRows = null;
    this.returnMode = 'many';
    this.returning = false;
  }

  select(columns = '*') { this.columns = columns || '*'; this.returning = this.action !== 'select'; return this; }
  insert(payload) { this.action = 'insert'; this.payload = payload; return this; }
  update(payload) { this.action = 'update'; this.payload = payload || {}; return this; }
  delete() { this.action = 'delete'; return this; }
  upsert(payload) { this.action = 'upsert'; this.payload = payload; return this; }
  eq(column, value) { this.filters.push({ op: 'eq', column, value }); return this; }
  neq(column, value) { this.filters.push({ op: 'neq', column, value }); return this; }
  in(column, value) { this.filters.push({ op: 'in', column, value }); return this; }
  is(column, value) { this.filters.push({ op: 'is', column, value }); return this; }
  not(column, operator, value) { this.filters.push({ op: 'not', column, operator, value }); return this; }
  lt(column, value) { this.filters.push({ op: 'lt', column, value }); return this; }
  lte(column, value) { this.filters.push({ op: 'lte', column, value }); return this; }
  gt(column, value) { this.filters.push({ op: 'gt', column, value }); return this; }
  gte(column, value) { this.filters.push({ op: 'gte', column, value }); return this; }
  or(expression) { this.filters.push({ op: 'or', conditions: parseOrExpression(expression) }); return this; }
  order(column, options = {}) { this.orders.push({ column, ascending: options.ascending !== false }); return this; }
  limit(value) { this.maxRows = Number(value); return this; }
  single() { this.returnMode = 'single'; return this; }
  maybeSingle() { this.returnMode = 'maybeSingle'; return this; }

  async execute() {
    try {
      let affected = [];
      if (this.action === 'insert' || this.action === 'upsert') {
        const values = Array.isArray(this.payload) ? this.payload : [this.payload || {}];
        affected = runTransaction(() => values.map((row) => saveRow(this.tableName, row)));
      } else {
        let rows = listRows(this.tableName).filter((row) => this.filters.every((filter) => matchesFilter(row, filter)));
        if (this.action === 'update') {
          affected = runTransaction(() => rows.map((row) => saveRow(this.tableName, {
            ...row,
            ...clone(this.payload),
            updated_at: new Date().toISOString(),
          })));
        } else if (this.action === 'delete') {
          runTransaction(() => rows.forEach((row) => removeRow.run(this.tableName, String(row.id))));
          affected = rows;
        } else {
          affected = rows;
        }
      }

      for (const order of this.orders.slice().reverse()) {
        affected.sort((left, right) => {
          const a = getValue(left, order.column);
          const b = getValue(right, order.column);
          if (a === b) return 0;
          if (a === null || a === undefined) return order.ascending ? -1 : 1;
          if (b === null || b === undefined) return order.ascending ? 1 : -1;
          return (a < b ? -1 : 1) * (order.ascending ? 1 : -1);
        });
      }
      if (Number.isFinite(this.maxRows) && this.maxRows >= 0) affected = affected.slice(0, this.maxRows);

      let data = affected.map((row) => projectRow(row, this.columns));
      if (this.action !== 'select' && !this.returning) data = null;
      if (this.returnMode === 'single') {
        if (!Array.isArray(data) || data.length !== 1) return { data: null, error: { message: `Expected one ${this.tableName} row, found ${data?.length || 0}` } };
        data = data[0];
      } else if (this.returnMode === 'maybeSingle') {
        if (Array.isArray(data) && data.length > 1) return { data: null, error: { message: `Expected at most one ${this.tableName} row, found ${data.length}` } };
        data = Array.isArray(data) ? data[0] || null : null;
      }
      return { data, error: null };
    } catch (error) {
      return { data: null, error: { message: error.message || String(error) } };
    }
  }

  then(resolve, reject) { return this.execute().then(resolve, reject); }
}

function safeStoragePath(bucket, objectPath) {
  const bucketName = String(bucket || 'files').replace(/[^a-zA-Z0-9._-]/g, '-');
  const segments = String(objectPath || '').replace(/\\/g, '/').split('/').filter(Boolean)
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, '-'));
  const root = path.resolve(STORAGE_DIR, bucketName);
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Unsafe storage path');
  return { root, target, relative: segments.join('/') };
}

function createStorageBucket(bucket) {
  return {
    async upload(objectPath, body, options = {}) {
      try {
        const { target } = safeStoragePath(bucket, objectPath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (!options.upsert && fs.existsSync(target)) return { data: null, error: { message: 'The resource already exists' } };
        let bytes;
        if (Buffer.isBuffer(body)) bytes = body;
        else if (body instanceof Uint8Array) bytes = Buffer.from(body);
        else if (body?.arrayBuffer) bytes = Buffer.from(await body.arrayBuffer());
        else bytes = Buffer.from(String(body ?? ''));
        const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temp, bytes);
        fs.renameSync(temp, target);
        return { data: { path: objectPath }, error: null };
      } catch (error) {
        return { data: null, error: { message: error.message || String(error) } };
      }
    },
    async download(objectPath) {
      try {
        const { target } = safeStoragePath(bucket, objectPath);
        const bytes = fs.readFileSync(target);
        return { data: new Blob([bytes]), error: null };
      } catch (error) {
        return { data: null, error: { message: error.message || String(error) } };
      }
    },
    getPublicUrl(objectPath) {
      const { relative } = safeStoragePath(bucket, objectPath);
      return { data: { publicUrl: `http://localhost:3001/api/local-storage/${encodeURIComponent(String(bucket))}/${relative.split('/').map(encodeURIComponent).join('/')}` } };
    },
    async remove(paths) {
      try {
        for (const objectPath of paths || []) {
          const { target } = safeStoragePath(bucket, objectPath);
          if (fs.existsSync(target)) fs.unlinkSync(target);
        }
        return { data: [], error: null };
      } catch (error) {
        return { data: null, error: { message: error.message || String(error) } };
      }
    },
  };
}

function createLocalSupabaseClient() {
  return {
    from(tableName) { return new LocalQuery(tableName); },
    storage: { from(bucket) { return createStorageBucket(bucket); } },
  };
}

function seedRecoveredAccounts(browserState) {
  const profiles = new Map((browserState?.profiles || []).map((profile) => [profile.id, profile]));
  const platformByProfile = {
    Main: ['youtube', 'tiktok', 'instagram'],
    gensweaty: ['youtube', 'tiktok', 'instagram'],
    Technewslist: ['youtube', 'tiktok', 'instagram'],
    X: ['x'],
    FB: ['facebook'],
    Linkedin: ['linkedin'],
  };
  const videoPlatforms = new Set(['youtube', 'tiktok', 'instagram']);
  const existingVideo = new Set(listRows('platform_accounts').map((row) => String(row.id)));
  const existingSocial = new Set(listRows('social_post_accounts').map((row) => String(row.id)));

  for (const [accountId, profileId] of Object.entries(browserState?.accountLinks || {})) {
    const profile = profiles.get(profileId);
    if (!profile) continue;
    const candidates = platformByProfile[profile.label] || [];
    const selectedPlatforms = Object.values(browserState.jobSelections || {})
      .concat(Object.values(browserState.scheduledSelections || {}))
      .filter((selection) => selection && typeof selection === 'object')
      .flatMap((selection) => Object.entries(selection))
      .filter(([, selectedId]) => String(selectedId) === String(accountId))
      .map(([platform]) => platform);
    const platform = selectedPlatforms.find((item) => candidates.includes(item)) || candidates[0];
    if (!platform) continue;
    const row = {
      id: accountId,
      platform,
      label: profile.label,
      name: profile.label,
      enabled: true,
      is_default: false,
      browser_profile_id: profileId,
      recovered_from: 'browser-profiles.json',
      recovery_verified_at: new Date().toISOString(),
    };
    if (videoPlatforms.has(platform) && !existingVideo.has(accountId)) saveRow('platform_accounts', row);
    if (!videoPlatforms.has(platform) && !existingSocial.has(accountId)) saveRow('social_post_accounts', row);
  }

  const currentSettings = listRows('app_settings').find((row) => String(row.id) === '1');
  if (!currentSettings) {
    saveRow('app_settings', {
      id: 1,
      folder_path: 'D:\\AI Video',
      delete_after_upload: true,
      telegram_enabled: false,
      local_agent_url: 'http://localhost:3001',
      ai_provider: 'lmstudio',
      ai_base_url: 'http://localhost:1234',
      ai_model: 'qwen3.8-27b-uncensored-aggressive',
      created_from_recovery: true,
      recovery_defaults_version: 2,
    });
  } else if (currentSettings.ai_provider !== 'lmstudio'
    || currentSettings.ai_model !== 'qwen3.8-27b-uncensored-aggressive'
    || currentSettings.ai_base_url !== 'http://127.0.0.1:1234') {
    saveRow('app_settings', {
      ...currentSettings,
      ai_provider: 'lmstudio',
      ai_base_url: 'http://127.0.0.1:1234',
      ai_model: 'qwen3.8-27b-uncensored-aggressive',
      local_model_contract_version: 1,
      local_model_contract_updated_at: new Date().toISOString(),
    });
  } else if (currentSettings.created_from_recovery && !currentSettings.recovery_defaults_version) {
    // The first local-recovery seed disabled cleanup. Migrate that seed once, then
    // respect any later choice the user makes in Settings.
    saveRow('app_settings', {
      ...currentSettings,
      delete_after_upload: true,
      recovery_defaults_version: 2,
      recovery_defaults_migrated_at: new Date().toISOString(),
    });
  }
}

function checkpointDatabase() {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

module.exports = {
  DB_FILE,
  DATA_DIR,
  STORAGE_DIR,
  checkpointDatabase,
  createLocalSupabaseClient,
  listRows,
  saveRow,
  seedRecoveredAccounts,
};
