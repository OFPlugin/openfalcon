// ============================================================
// /api/admin/backup/* — Backup & Restore endpoints (v0.25.0+)
// ============================================================
// All admin-authenticated EXCEPT /restore-first-boot which is
// gated by the "still in first-boot state" check (only one user,
// admin/admin, must_change_password=1). This lets a fresh install
// restore from a backup before the user logs in for the first time.

const express = require('express');
const router = express.Router();
const backup = require('../lib/backup');

// Body size limit for restore. Cover art is base64-encoded so
// backup files are bigger than raw — allow 100 MB which covers
// shows with many sequences and cover art included.
const RESTORE_BODY_LIMIT = '100mb';

// ============================================================
// GET /api/admin/backup/export?coverArt=1
// ============================================================
// Builds a backup and streams it as a JSON download. The browser
// will save it as showpilot-backup-<date>.json based on the
// Content-Disposition header.
router.get('/export', (req, res) => {
  try {
    const includeCoverArt = String(req.query.coverArt || '0') === '1';
    const data = backup.buildBackup({ includeCoverArt });
    const ts = new Date().toISOString()
      .slice(0, 16)
      .replace(/[T:]/g, '-')
      .replace(/-(\d{2})$/, '-$1');
    const filename = `showpilot-backup-${ts}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(data));
  } catch (err) {
    console.error('[backup/export] failed:', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// ============================================================
// POST /api/admin/backup/inspect
// ============================================================
// Body is the full backup JSON. Returns a summary suitable for
// driving the restore-confirmation UI. Doesn't write anything.
router.post('/inspect', express.json({ limit: RESTORE_BODY_LIMIT }), (req, res) => {
  try {
    const summary = backup.inspectBackup(req.body);
    res.json({ ok: true, summary });
  } catch (err) {
    console.warn('[backup/inspect] invalid backup:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ============================================================
// POST /api/admin/backup/restore
// ============================================================
// Body: { backup: <json>, policies: { config, sequences, templates,
//         users, secrets, coverArt } }
// Performs the restore atomically. If `secrets: 'replace'`, the
// response includes requiresRestart=true and the server should be
// restarted by the operator (or PM2 if configured).
router.post('/restore', express.json({ limit: RESTORE_BODY_LIMIT }), (req, res) => {
  try {
    const { backup: bkp, policies } = req.body || {};
    if (!bkp) return res.status(400).json({ error: 'Missing backup data' });
    if (!policies || typeof policies !== 'object') {
      return res.status(400).json({ error: 'Missing policies object' });
    }

    // Sanity: 'secrets' policy is checked separately from sections;
    // default to 'keep' if not specified to avoid accidentally
    // replacing config.js when the user only wanted DB restore.
    const safePolicies = {
      config: policies.config || 'skip',
      sequences: policies.sequences || 'skip',
      templates: policies.templates || 'skip',
      users: policies.users || 'skip',
      secrets: policies.secrets === 'replace' ? 'replace' : 'keep',
      coverArt: policies.coverArt === 'skip' ? 'skip' : 'restore',
    };

    const result = backup.restoreBackup(bkp, safePolicies);
    console.log('[backup/restore] complete:', JSON.stringify(result));

    res.json({ ok: true, result });

    // If secrets were restored, schedule a restart after the response
    // has been flushed. We rely on the process manager (PM2/systemd)
    // to bring the server back. Without a process manager, this is a
    // hard exit — admin must restart manually.
    if (result.requiresRestart) {
      setTimeout(() => {
        console.log('[backup/restore] exiting for restart (secrets changed)');
        process.exit(0);
      }, 1500);
    }
  } catch (err) {
    console.error('[backup/restore] failed:', err);
    res.status(500).json({ error: 'Restore failed: ' + err.message });
  }
});

// ============================================================
// GET /api/setup/first-boot-status (no auth)
// ============================================================
// Tells the login screen whether to show the "Restore from backup"
// option. True iff the install is still in its initial state.
function firstBootStatusHandler(req, res) {
  res.json({ firstBoot: backup.isFirstBoot() });
}

// ============================================================
// POST /api/setup/restore-from-backup (no auth, gated by first-boot)
// ============================================================
// Allows restoring from a backup before any admin login has happened.
// Only works if isFirstBoot() returns true. After restore, the
// imported users replace the default admin/admin and the operator
// logs in with the imported credentials.
function restoreFirstBootHandler(req, res) {
  if (!backup.isFirstBoot()) {
    return res.status(403).json({
      error: 'First-boot restore is only allowed on a fresh install. Use the in-app restore from the admin dashboard instead.',
    });
  }
  try {
    const { backup: bkp } = req.body || {};
    if (!bkp) return res.status(400).json({ error: 'Missing backup data' });

    // First-boot is always a clean replacement — there's no
    // destination data worth merging with.
    const policies = {
      config: 'replace',
      sequences: 'replace',
      templates: 'replace',
      users: 'replace',
      secrets: 'replace',
      coverArt: 'restore',
    };
    const result = backup.restoreBackup(bkp, policies);
    console.log('[backup/restore-first-boot] complete:', JSON.stringify(result));
    res.json({ ok: true, result });

    // First-boot restore always replaces secrets, so always restart.
    setTimeout(() => {
      console.log('[backup/restore-first-boot] exiting for restart');
      process.exit(0);
    }, 1500);
  } catch (err) {
    console.error('[backup/restore-first-boot] failed:', err);
    res.status(500).json({ error: 'Restore failed: ' + err.message });
  }
}

module.exports = router;
module.exports.firstBootStatusHandler = firstBootStatusHandler;
module.exports.restoreFirstBootHandler = restoreFirstBootHandler;
