const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DATA_DIR,
  DB_FILE,
  checkpointDatabase,
} = require('./localDatabase');

const LOCAL_BACKUP_ROOT = path.join(DATA_DIR, 'snapshots');
const MACHINE_BACKUP_ROOT = 'C:\\AI-Factory-Backups\\Auto Vid Post Metadata';
const ONEDRIVE_ROOT = process.env.OneDrive || path.join(os.homedir(), 'OneDrive');
const SYNCED_BACKUP_ROOT = path.join(ONEDRIVE_ROOT, 'Documents', 'Auto Vid Post Backups');
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const METADATA_FILES = [
  DB_FILE,
  path.join(DATA_DIR, 'browser-profiles.json'),
  path.join(DATA_DIR, 'browser-profiles.json.bak'),
  path.join(DATA_DIR, 'folder-watch-state.json'),
];

function timestamp() {
  return new Date().toISOString().replace(/[-:.]/g, '');
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeSnapshot(root, snapshotId) {
  const destination = path.join(root, snapshotId);
  const staging = `${destination}.partial-${process.pid}`;
  fs.mkdirSync(staging, { recursive: true });

  const files = [];
  for (const source of METADATA_FILES) {
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    const target = path.join(staging, path.basename(source));
    fs.copyFileSync(source, target);
    files.push({
      name: path.basename(source),
      bytes: fs.statSync(target).size,
      sha256: sha256(target),
    });
  }

  const manifest = {
    format: 'AUTO_VID_POST_LOCAL_BACKUP_V1',
    created_at: new Date().toISOString(),
    source: DATA_DIR,
    files,
    exclusions: [
      'browser cookies and browser profile directories',
      'secrets and environment files',
      'generated media and video files',
    ],
  };
  fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.renameSync(staging, destination);
  return destination;
}

function createLocalSnapshot() {
  checkpointDatabase();
  const snapshotId = timestamp();
  fs.mkdirSync(LOCAL_BACKUP_ROOT, { recursive: true });
  fs.mkdirSync(MACHINE_BACKUP_ROOT, { recursive: true });
  fs.mkdirSync(SYNCED_BACKUP_ROOT, { recursive: true });

  const localPath = writeSnapshot(LOCAL_BACKUP_ROOT, snapshotId);
  const machinePath = writeSnapshot(MACHINE_BACKUP_ROOT, snapshotId);
  const syncedPath = writeSnapshot(SYNCED_BACKUP_ROOT, snapshotId);
  console.log(`[Backup] Metadata snapshot saved locally: ${localPath}`);
  console.log(`[Backup] Metadata snapshot saved outside the application: ${machinePath}`);
  console.log(`[Backup] Metadata snapshot saved to OneDrive: ${syncedPath}`);
  return { localPath, machinePath, syncedPath };
}

function startLocalBackupSchedule() {
  try {
    createLocalSnapshot();
  } catch (error) {
    console.error('[Backup] Startup snapshot failed without stopping the app:', error.message);
  }

  const timer = setInterval(() => {
    try {
      createLocalSnapshot();
    } catch (error) {
      console.error('[Backup] Scheduled snapshot failed without stopping the app:', error.message);
    }
  }, BACKUP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

module.exports = {
  LOCAL_BACKUP_ROOT,
  MACHINE_BACKUP_ROOT,
  SYNCED_BACKUP_ROOT,
  createLocalSnapshot,
  startLocalBackupSchedule,
};
