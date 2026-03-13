/**
 * session.store.js
 * In-memory session store for QR pairing sessions.
 * Replace with Redis for multi-instance / production use.
 */

const crypto = require('crypto');

// SESSION_TTL: how long a session lives (ms) — 24 hours
const SESSION_TTL = 24 * 60 * 60 * 1000;

// RECONNECT_TTL: grace window after WS drop before session is marked stale (ms)
const RECONNECT_TTL = 60 * 1000; // 1 minute

/**
 * Session shape:
 * {
 *   id:          string   — unique session identifier (embedded in QR)
 *   pairToken:   string   — secret issued after pairing; used for reconnect auth
 *   status:      'pending' | 'paired' | 'connected' | 'disconnected'
 *   tvSocketId:  string | null
 *   mobileSocketId: string | null
 *   createdAt:   number
 *   pairedAt:    number | null
 *   lastSeenAt:  number
 *   meta:        object   — optional caller-supplied data (device info, etc.)
 * }
 */

const sessions = new Map();

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function now() {
  return Date.now();
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Create a new pending session.
 * @returns {object} session
 */
function createSession(meta = {}) {
  const id = generateId(16);
  const session = {
    id,
    pairToken: null,           // issued on pairing
    status: 'pending',
    tvSocketId: null,
    mobileSocketId: null,
    createdAt: now(),
    pairedAt: null,
    lastSeenAt: now(),
    meta,
  };
  sessions.set(id, session);
  return session;
}

/**
 * Retrieve a session by ID. Returns null if not found or expired.
 */
function getSession(id) {
  const session = sessions.get(id);
  if (!session) return null;
  if (now() - session.createdAt > SESSION_TTL) {
    sessions.delete(id);
    return null;
  }
  return session;
}

/**
 * Retrieve a session by pairToken (used for WS reconnects).
 */
function getSessionByToken(pairToken) {
  for (const session of sessions.values()) {
    if (session.pairToken === pairToken) return session;
  }
  return null;
}

/**
 * Mark a session as paired and issue a pairToken.
 * @returns {object|null} updated session, or null if session not found
 */
function pairSession(id, mobileMeta = {}) {
  const session = getSession(id);
  if (!session) return null;
  if (session.status !== 'pending') return null; // already paired

  session.pairToken = generateId(32);
  session.status = 'paired';
  session.pairedAt = now();
  session.lastSeenAt = now();
  session.meta = { ...session.meta, mobile: mobileMeta };
  sessions.set(id, session);
  return session;
}

/**
 * Update socket references and status on a session.
 */
function updateSessionSocket(id, role, socketId) {
  const session = getSession(id);
  if (!session) return null;

  if (role === 'tv') session.tvSocketId = socketId;
  if (role === 'mobile') session.mobileSocketId = socketId;

  // Both sides connected → mark connected
  if (session.tvSocketId && session.mobileSocketId) {
    session.status = 'connected';
  }

  session.lastSeenAt = now();
  sessions.set(id, session);
  return session;
}

/**
 * Mark a socket as disconnected. Keeps session alive for RECONNECT_TTL.
 */
function clearSessionSocket(id, role) {
  const session = sessions.get(id);
  if (!session) return;

  if (role === 'tv') session.tvSocketId = null;
  if (role === 'mobile') session.mobileSocketId = null;

  session.status = 'disconnected';
  session.lastSeenAt = now();
  sessions.set(id, session);
}

/**
 * Delete a session explicitly.
 */
function deleteSession(id) {
  sessions.delete(id);
}

// ─── Periodic cleanup of expired sessions ───────────────────────────────────

setInterval(() => {
  const cutoff = now() - SESSION_TTL;
  for (const [id, session] of sessions.entries()) {
    if (session.createdAt < cutoff) sessions.delete(id);
  }
}, 10 * 60 * 1000); // every 10 minutes

module.exports = {
  createSession,
  getSession,
  getSessionByToken,
  pairSession,
  updateSessionSocket,
  clearSessionSocket,
  deleteSession,
  RECONNECT_TTL,
};