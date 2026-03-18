/**
 * qr-code.controller.js
 *
 * Handles:
 *   POST /api/create-qr        — TV requests a new (or existing) QR session
 *   POST /api/pair-qr          — Mobile scans QR and pairs
 *   GET  /api/polling/:id      — TV long-polls until session is paired
 *   GET  /api/session/:id      — Lightweight session status check
 *   DELETE /api/session/:id    — Explicit logout / session deletion
 *
 * ─── No pairToken ────────────────────────────────────────────────────────────
 * The previous version issued a pairToken on pairing and required it for
 * mobile reconnects. This version removes it entirely.
 *
 * Both TV and mobile reconnect with just sessionId:
 *   ws://host/ws?role=tv&sessionId=<id>
 *   ws://host/ws?role=mobile&sessionId=<id>
 *
 * Sessions never expire from inactivity — only explicit DELETE removes them.
 */

const QRCode = require('qrcode');
const store  = require('./session.store');

// ─── Config ───────────────────────────────────────────────────────────────────

const QR_BASE_URL        = process.env.QR_BASE_URL || 'https://yourapp.com/pair';
const LONG_POLL_TIMEOUT  = 20_000; // ms — max wait per long-poll request
const POLL_INTERVAL      = 500;    // ms — check interval inside long-poll

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Long-poll: wait until session.status !== 'pending', or timeout.
 * Uses getOrCreateSession so it never returns null.
 */
function waitForPairing(sessionId, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const tick = () => {
      const session = store.getOrCreateSession(sessionId);

      if (session.status !== 'pending') return resolve(session); // paired ✓
      if (Date.now() >= deadline)       return resolve(session); // timeout (still pending)

      setTimeout(tick, POLL_INTERVAL);
    };

    tick();
  });
}

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * POST /api/create-qr
 *
 * TV calls this on startup (or when showing the QR screen).
 *
 * If the TV already has a sessionId in storage, pass it in the body so the
 * same session is reused — no new QR needed. If not, a new one is created.
 *
 * Body (optional): { sessionId?: string, meta?: object }
 *
 * Response:
 * {
 *   success:   true,
 *   sessionId: string,   ← TV must persist this in AsyncStorage as 'roomId'
 *   qrDataUrl: string,   ← base64 PNG for <img src="...">
 *   pairingUrl: string,  ← URL embedded in QR (for debug / manual entry)
 *   status:    string,   ← 'pending' | 'paired' | 'connected' | 'disconnected'
 * }
 *
 * CHANGED: removed pairToken from response. Added sessionId pass-through so
 * TV can reuse existing session after server restart instead of generating new QR.
 */
async function createQr(req, res) {
  try {
    const { sessionId: existingId, meta = {} } = req.body || {};

    // If TV supplies its stored sessionId, reuse that session (or recreate it
    // transparently if the server was restarted and lost it).
    // If TV has no stored sessionId, create a brand new session.
    const session = existingId
      ? store.getOrCreateSession(existingId, meta) // reuse / restore
      : store.createSession(null, meta);           // brand new

    const pairingUrl = `${QR_BASE_URL}?sessionId=${session.id}`;

    // QR encodes only the sessionId — mobile sends this to /api/pair-qr
    const qrDataUrl = await QRCode.toDataURL(session.id, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width:  300,
      color:  { dark: '#000000', light: '#ffffff' },
    });

    return res.status(201).json({
      success:    true,
      sessionId:  session.id,   // ← TV stores this as 'roomId' in AsyncStorage
      qrDataUrl,
      pairingUrl,
      status:     session.status,
    });
  } catch (err) {
    console.error('[createQr] error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create QR session' });
  }
}

/**
 * POST /api/pair-qr
 *
 * Mobile calls this after scanning the QR code.
 * Marks the session as paired so the TV's poll resolves.
 *
 * Body: { sessionId: string, meta?: object }
 *
 * Response:
 * {
 *   success:   true,
 *   sessionId: string,   ← mobile stores this in AsyncStorage as 'roomId'
 *   status:    string,
 * }
 *
 * CHANGED:
 *  - Removed pairToken from response entirely
 *  - Uses getOrCreateSession instead of getSession — never returns 404
 *  - If already paired, still returns success (idempotent) so mobile can
 *    safely call this again on re-scan without breaking anything
 */
async function pairQr(req, res) {
  try {
    const { sessionId, meta = {} } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    // getOrCreateSession: never returns null — recreates if missing
    const session = store.getOrCreateSession(sessionId, meta);

    if (session.status !== 'pending') {
      // Already paired — idempotent success
      // Mobile may call this again if it lost its state; just confirm the session
      return res.status(200).json({
        success:   true,
        sessionId: session.id,
        status:    session.status,
        message:   'Session already paired. Connect WebSocket now.',
      });
    }

    // Mark as paired — no token issued
    const paired = store.pairSession(session.id);

    return res.status(200).json({
      success:   true,
      sessionId: paired.id,   // ← mobile stores this as 'roomId' in AsyncStorage
      status:    paired.status,
      message:   'Pairing successful. Connect WebSocket now.',
    });
  } catch (err) {
    console.error('[pairQr] error:', err);
    return res.status(500).json({ success: false, message: 'Pairing error' });
  }
}

/**
 * GET /api/polling/:sessionId
 *
 * Long-poll for TV. Hangs until session.status !== 'pending' or ~20s timeout.
 * TV calls this in a loop after showing the QR until it sees status = 'paired'.
 *
 * CHANGED: uses getOrCreateSession internally so it never returns 404.
 * Even if the server restarted mid-poll, the session is recreated and TV
 * continues polling normally.
 *
 * Response:
 * {
 *   success:   true,
 *   sessionId: string,
 *   status:    'pending' | 'paired' | 'connected' | 'disconnected',
 *   pairedAt:  number | null,
 * }
 */
async function pollSession(req, res) {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    const session = await waitForPairing(sessionId, LONG_POLL_TIMEOUT);

    return res.status(200).json({
      success:   true,
      sessionId: session.id,
      status:    session.status,
      pairedAt:  session.pairedAt,
    });
  } catch (err) {
    console.error('[pollSession] error:', err);
    return res.status(500).json({ success: false, message: 'Polling error' });
  }
}

/**
 * GET /api/session/:sessionId
 *
 * Lightweight status check — no long-poll.
 * Used by TV/mobile after a WS reconnect to confirm session is still valid.
 *
 * CHANGED: uses getOrCreateSession — never returns 404.
 * If the session was lost (server restart), it is recreated and the client
 * knows to reconnect its WS.
 *
 * Response:
 * {
 *   success:  true,
 *   sessionId: string,
 *   status:   string,
 *   pairedAt: number | null,
 * }
 */
async function getSessionStatus(req, res) {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    // getOrCreateSession: if session was wiped, recreate it so client can reconnect
    const session = store.getOrCreateSession(sessionId);

    return res.status(200).json({
      success:   true,
      sessionId: session.id,
      status:    session.status,
      pairedAt:  session.createdAt,
    });
  } catch (err) {
    console.error('[getSessionStatus] error:', err);
    return res.status(500).json({ success: false, message: 'Error fetching session' });
  }
}

/**
 * DELETE /api/session/:sessionId
 *
 * Explicit logout. The ONLY way a session is permanently deleted.
 * Call this when the user logs out from TV or mobile.
 * After this, clients must re-scan QR to create a new session.
 *
 * ADDED: was missing in previous version — there was no logout endpoint.
 */
async function deleteSessionHandler(req, res) {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    store.deleteSession(sessionId);

    return res.status(200).json({
      success: true,
      message: 'Session deleted. Re-scan QR to reconnect.',
    });
  } catch (err) {
    console.error('[deleteSession] error:', err);
    return res.status(500).json({ success: false, message: 'Error deleting session' });
  }
}

module.exports = {
  createQr,
  pairQr,
  pollSession,
  getSessionStatus,
  deleteSessionHandler,
};