'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile, exec, spawn } = require('child_process');
const { DEFAULT_MODEL, ensureSingleLocalLLM } = require('./lm-studio-model-manager');

const BASE_URL = (process.env.LM_STUDIO_URL || 'http://localhost:1234').replace(/\/+$/, '');
const PORT = (() => {
  try { return new URL(BASE_URL).port || '1234'; } catch { return '1234'; }
})();

function execAsync(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(command, { windowsHide: true, timeout: options.timeout || 30_000 }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(error, { stdout, stderr }));
      resolve({ stdout, stderr });
    });
  });
}

function execFileAsync(file, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: options.timeout || 120_000 }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(error, { stdout, stderr }));
      resolve({ stdout, stderr });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(url, timeout = 4_000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        try { resolve(JSON.parse(body || '{}')); } catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function waitForApi(seconds) {
  for (let i = 0; i < seconds; i += 1) {
    try {
      await requestJson(`${BASE_URL}/v1/models`);
      return true;
    } catch {}
    await sleep(1_000);
  }
  return false;
}

async function getLoadedModels() {
  const data = await requestJson(`${BASE_URL}/v1/models`);
  return Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
}

async function isAppRunning() {
  try {
    const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq LM Studio.exe" /FO CSV /NH', { timeout: 8_000 });
    return /LM Studio\.exe/i.test(stdout);
  } catch {
    return false;
  }
}

function existing(paths) {
  return paths.filter(Boolean).find((p) => fs.existsSync(p));
}

async function findCommand(command, extraPaths = []) {
  try {
    const { stdout } = await execAsync(`where ${command}`, { timeout: 8_000 });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first) return first;
  } catch {}
  return existing(extraPaths) || command;
}

async function startLmStudioApp() {
  if (await isAppRunning()) {
    console.log('[LM Studio] Windows app is already running.');
    return;
  }

  const exe = existing([
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LM Studio', 'LM Studio.exe'),
    path.join(process.env.ProgramFiles || '', 'LM Studio', 'LM Studio.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'LM Studio', 'LM Studio.exe'),
  ]);

  if (!exe) {
    console.log('[LM Studio] App executable was not found in common install paths. Trying CLI server only.');
    return;
  }

  console.log(`[LM Studio] Opening app: ${exe}`);
  const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function findLmsCli() {
  return findCommand('lms', [
    path.join(process.env.USERPROFILE || '', '.cache', 'lm-studio', 'bin', 'lms.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'lm-studio', 'bin', 'lms.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LM Studio', 'resources', 'app', '.webpack', 'main', 'lms.exe'),
  ]);
}

async function startApiServer(lmsPath) {
  console.log(`[LM Studio] Starting API server on ${BASE_URL}...`);
  const cmd = `start "LM Studio API" "${lmsPath}" server start --port ${PORT} --cors`;
  const child = spawn('cmd.exe', ['/d', '/s', '/c', cmd], { detached: true, stdio: 'ignore' });
  child.unref();
}

function collectModelIds(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    value.forEach((item) => collectModelIds(item, out));
    return out;
  }
  if (typeof value === 'object') {
    const id = value.modelKey || value.path || value.id || value.name;
    if (typeof id === 'string' && id.trim()) out.push(id.trim());
    collectModelIds(value.models, out);
    collectModelIds(value.data, out);
  }
  return out;
}

async function firstAvailableModel(lmsPath) {
  try {
    const { stdout } = await execFileAsync(lmsPath, ['ls', '--json'], { timeout: 30_000 });
    const ids = [...new Set(collectModelIds(JSON.parse(stdout || '[]')))];
    return ids[0] || '';
  } catch (err) {
    console.log(`[LM Studio] Could not read model list through CLI: ${err.message}`);
    return '';
  }
}

async function ensureModelLoaded(lmsPath) {
  try {
    const preferredModel = String(process.env.LM_STUDIO_MODEL || DEFAULT_MODEL).trim();
    const runtime = await ensureSingleLocalLLM({
      preferredModel,
      baseUrl: BASE_URL,
      loadIfMissing: true,
    });
    console.log(`[LM Studio] The only active agent model is ${runtime.modelId} (${runtime.modelKey}).`);
    return true;
  } catch (err) {
    console.log(`[LM Studio] Guarded model startup failed: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log('[LM Studio] Preparing local AI on localhost:1234...');
  await startLmStudioApp();
  const lmsPath = await findLmsCli();

  if (!(await waitForApi(8))) {
    await startApiServer(lmsPath);
  }

  if (!(await waitForApi(60))) {
    console.log('[LM Studio] API did not become ready. Telegram AI will work after LM Studio server mode is started.');
    return;
  }

  console.log('[LM Studio] API is ready.');
  await ensureModelLoaded(lmsPath);
}

main().catch((err) => {
  console.log(`[LM Studio] Startup helper warning: ${err.message}`);
}).finally(() => process.exit(0));
