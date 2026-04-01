'use strict';

/**
 * Backup module — SQLite → compressed → GitHub private repo
 *
 * Strategy:
 *  1. SQLite VACUUM INTO creates a consistent, clean snapshot (atomic read)
 *  2. gzip compresses 70-80% — a 5MB DB becomes ~1MB
 *  3. GitHub REST API stores it in a private repo (free, versioned)
 *  4. Rolling 30-day window: oldest backups auto-deleted to save space
 *
 * Required env vars (optional — download always works):
 *   BACKUP_GITHUB_TOKEN   Personal access token with repo scope
 *   BACKUP_GITHUB_REPO    e.g. "AntaresRed/attendance-backups" (must be private)
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const db   = require('../db/database');

const gzip    = promisify(zlib.gzip);
const gunzip  = promisify(zlib.gunzip);
const DB_PATH = process.env.DB_PATH || './data/attendance.db';

// ── Core: create an in-memory compressed backup ───────────────────────────────
async function createBackupBuffer() {
  const tmpPath = path.resolve(DB_PATH + '.bak_tmp');
  try {
    // VACUUM INTO is SQLite's built-in hot-backup — safe while the DB is in use
    db.getDb().exec(`VACUUM INTO '${tmpPath}'`);
    const raw        = fs.readFileSync(tmpPath);
    const compressed = await gzip(raw);
    return compressed;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* already gone */ }
  }
}

// ── GitHub API helpers ────────────────────────────────────────────────────────
function ghHeaders() {
  return {
    'Authorization':        `Bearer ${process.env.BACKUP_GITHUB_TOKEN}`,
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type':         'application/json',
    'User-Agent':           'attendance-bot-backup/1.0',
  };
}

async function pushToGitHub(buffer, filename) {
  const token = process.env.BACKUP_GITHUB_TOKEN;
  const repo  = process.env.BACKUP_GITHUB_REPO;
  if (!token || !repo) {
    console.warn('[Backup] BACKUP_GITHUB_TOKEN / BACKUP_GITHUB_REPO not set — skipping push.');
    return null;
  }

  const url     = `https://api.github.com/repos/${repo}/contents/${filename}`;
  const headers = ghHeaders();

  // Check if a file for today already exists (need its SHA to update it)
  let sha = null;
  try {
    const check = await fetch(url, { headers });
    if (check.ok) sha = (await check.json()).sha;
  } catch (_) {}

  const body = JSON.stringify({
    message: `backup: ${filename}`,
    content: buffer.toString('base64'),
    ...(sha ? { sha } : {}),
  });

  const res = await fetch(url, { method: 'PUT', headers, body });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API ${res.status}: ${err}`);
  }

  return `https://github.com/${repo}/blob/main/${filename}`;
}

// ── Retention: keep only the last N backups ───────────────────────────────────
async function pruneOldBackups(keepCount = 30) {
  const token = process.env.BACKUP_GITHUB_TOKEN;
  const repo  = process.env.BACKUP_GITHUB_REPO;
  if (!token || !repo) return;

  const headers = ghHeaders();
  const res = await fetch(`https://api.github.com/repos/${repo}/contents`, { headers });
  if (!res.ok) return;

  const files   = await res.json();
  const backups = (Array.isArray(files) ? files : [])
    .filter(f => f.name.startsWith('attendance-') && f.name.endsWith('.db.gz'))
    .sort((a, b) => a.name.localeCompare(b.name)); // oldest first

  const toDelete = backups.slice(0, Math.max(0, backups.length - keepCount));
  for (const file of toDelete) {
    await fetch(`https://api.github.com/repos/${repo}/contents/${file.name}`, {
      method:  'DELETE',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `prune: ${file.name}`, sha: file.sha }),
    });
    console.log(`[Backup] Pruned old backup: ${file.name}`);
  }
}

// ── Public entry point ────────────────────────────────────────────────────────
async function runBackup() {
  console.log('[Backup] Starting backup...');
  const date     = new Date().toISOString().slice(0, 10);
  const filename = `attendance-${date}.db.gz`;

  try {
    const buffer = await createBackupBuffer();
    const url    = await pushToGitHub(buffer, filename);

    const kb = (buffer.length / 1024).toFixed(1);
    if (url) {
      console.log(`[Backup] ✅ ${filename} pushed (${kb} KB compressed)`);
      await pruneOldBackups(30);
    } else {
      console.log(`[Backup] ✅ Buffer created locally (${kb} KB) — GitHub not configured`);
    }

    return { ok: true, filename, sizeKb: parseFloat(kb), url };
  } catch (err) {
    console.error('[Backup] ❌ Failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Restore: Replace live DB and restart ──────────────────────────────────────
async function restoreBackup(compressedBuffer) {
  console.log('[Backup] Starting database restore...');
  const rawDb = await gunzip(compressedBuffer);

  // Close live connection cleanly
  try { db.getDb().close(); } catch (_) { }

  // Overwrite the file and force a restart
  fs.writeFileSync(path.resolve(DB_PATH), rawDb);
  console.log('[Backup] Database file overwritten. Restarting app to reload...');
  setTimeout(() => process.exit(0), 1500); // 1.5s delay to let HTTP response complete
}

module.exports = { createBackupBuffer, runBackup, restoreBackup };
