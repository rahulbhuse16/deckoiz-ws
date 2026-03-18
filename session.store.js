/**
 * session.store.js
 *
 * Persistent session store — sessionId only, no pairToken.
 *
 * ─── Design principles ────────────────────────────────────────────────────────
 *  • Sessions NEVER expire from inactivity alone — only explicit logout deletes them
 *  • Server restarts are transparent — sessions reload from disk automatically
 *  • Any client with a valid sessionId can always connect — no secondary auth
 *  • Both TV and mobile connect with just: ws://host/ws?role=tv&sessionId=<id>
 *
 * ─── Session shape ────────────────────────────────────────────────────────────
 * {
 *   id:             string   — session identifier (embedded in QR code)
 *   status:         'pending' | 'paired' | 'connected' | 'disconnected'
 *   tvSocketId:     string | null
 *   mobileSocketId: string | null
 *   createdAt:      number   (ms)
 *   pairedAt:       number | null
 *   lastSeenAt:     number   (ms)
 *   meta:           object
 * }
 *
 * ─── Production note ─────────────────────────────────────────────────────────
 * This uses file-based persistence. For multi-instance deployments swap
 * _load/_save with Redis get/set — the API surface stays identical.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

// Sessions are only cleaned up if they haven't been seen for 365 days
// Effectively: sessions live until the user logs out
const SESSION_TTL   = 365 * 24 * 60 * 60 * 1000;

// Debounce disk writes to avoid thrashing on rapid updates
const SAVE_DEBOUNCE = 300; // ms

// Persist next to this file
const STORE_PATH = path.join(__dirname, '.sessions.json');

// ─── In-memory map ────────────────────────────────────────────────────────────

const sessions = new Map();
let _saveTimer = null;

// ─── Disk persistence ─────────────────────────────────────────────────────────

function _load() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      console.log('[Store] No session file — starting fresh');
      return;
    }
    const raw     = fs.readFileSync(STORE_PATH, 'utf8');
    const entries = JSON.parse(raw);
    const cutoff  = Date.now() - SESSION_TTL;
    let loaded    = 0;

    for (const session of entries) {
      if (session.lastSeenAt < cutoff) continue; // only skip truly ancient ones
      // Always reset socket IDs on load — they are runtime-only references
      session.tvSocketId     = null;
      session.mobileSocketId = null;
      session.status         = session.status === 'connected' ? 'disconnected' : session.status;
      sessions.set(session.id, session);
      loaded++;
    }

    console.log(`[Store] Loaded ${loaded} sessions from disk`);
  } catch (err) {
    console.error('[Store] Failed to load sessions:', err.message);
  }
}

function _save() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify([...sessions.values()], null, 2), 'utf8');
  } catch (err) {
    console.error('[Store] Failed to save sessions:', err.message);
  }
}

function _scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    _save();
  }, SAVE_DEBOUNCE);
}

function _touch(session) {
  session.lastSeenAt = Date.now();
  sessions.set(session.id, session);
  _scheduleSave();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a new unique session ID.
 * Called by the QR generation endpoint.
 */
function generateSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Create a new session with a given (or generated) ID.
 * If a session with this ID already exists, returns it as-is.
 * This makes it safe to call on every TV startup.
 */
function createSession(id = null, meta = {}) {
  const sessionId = id || generateSessionId();

  // Return existing session if it already exists — idempotent
  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId);
    _touch(existing);
    return existing;
  }

  const session = {
    id:             sessionId,
    status:         'pending',
    tvSocketId:     null,
    mobileSocketId: null,
    createdAt:      Date.now(),
    pairedAt:       null,
    lastSeenAt:     Date.now(),
    meta,
  };

  sessions.set(sessionId, session);
  _scheduleSave();
  console.log(`[Store] Created session ${sessionId}`);
  return session;
}

/**
 * Get a session by ID.
 *
 * KEY BEHAVIOUR: never returns null for a known sessionId.
 * If the session was wiped (server restart lost the file somehow),
 * it is transparently recreated. Clients with a valid sessionId
 * will NEVER be told "session not found".
 */
function getOrCreateSession(id, meta = {}) {
  const session = sessions.get(id);
  if (session) {
    _touch(session);
    return session;
  }

  // Session not in memory (server restart, file missing, etc.)
  // Recreate it transparently — client keeps their sessionId
  console.log(`[Store] Session ${id} not found — recreating (server restart?)`);
  return createSession(id, meta);
}

/**
 * Standard getSession — returns null if not found.
 * Use this when you explicitly want to know if a session existed.
 */
function getSession(id) {
  return sessions.get(id) || null;
}

/**
 * Mark a session as paired (both TV and mobile have connected at least once).
 */
function pairSession(id) {
  const session = sessions.get(id);
  if (!session) return null;

  if (session.status === 'pending') {
    session.status   = 'paired';
    session.pairedAt = Date.now();
    _touch(session);
    console.log(`[Store] Session ${id} paired`);
  }
  return session;
}

/**
 * Update which socket is currently connected for a role.
 */
function updateSessionSocket(id, role, socketId) {
  const session = sessions.get(id);
  if (!session) return null;

  if (role === 'tv')     session.tvSocketId     = socketId;
  if (role === 'mobile') session.mobileSocketId = socketId;

  if (session.tvSocketId && session.mobileSocketId) {
    session.status = 'connected';
    if (!session.pairedAt) {
      session.pairedAt = Date.now(); // 👈 always set once
    }
  }

  _touch(session);
  return session;
}

/**
 * Clear a socket reference when a client disconnects.
 * The session stays alive — client will reconnect.
 */
function clearSessionSocket(id, role) {
  const session = sessions.get(id);
  if (!session) return;

  if (role === 'tv')     session.tvSocketId     = null;
  if (role === 'mobile') session.mobileSocketId = null;

  // Only mark disconnected if both sockets are gone
  if (!session.tvSocketId && !session.mobileSocketId) {
    session.status = 'disconnected';
  }

  session.lastSeenAt = Date.now();
  sessions.set(id, session);
  _scheduleSave();
}

/**
 * Permanently delete a session.
 * Only call this on explicit user logout.
 */
function deleteSession(id) {
  if (sessions.delete(id)) {
    _scheduleSave();
    console.log(`[Store] Session ${id} deleted (logout)`);
  }
}

/**
 * List all sessions (for admin/debug).
 */
function listSessions() {
  return [...sessions.values()];
}

// ─── Cleanup truly ancient sessions (365+ days inactive) ─────────────────────

setInterval(() => {
  const cutoff  = Date.now() - SESSION_TTL;
  let   removed = 0;
  for (const [id, session] of sessions.entries()) {
    if (session.lastSeenAt < cutoff) {
      sessions.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[Store] Cleaned up ${removed} ancient sessions`);
    _scheduleSave();
  }
}, 24 * 60 * 60 * 1000); // run once per day

// ─── Startup load ─────────────────────────────────────────────────────────────

_load();

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function _flush() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _save();
  }
}

process.on('SIGTERM', _flush);
process.on('SIGINT',  _flush);
process.on('exit',    _flush);

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  generateSessionId,
  createSession,
  getSession,
  getOrCreateSession,
  pairSession,
  updateSessionSocket,
  clearSessionSocket,
  deleteSession,
  listSessions,
};