/**
 * qr-code.controller.js
 *
 * Handles:
 *   POST /api/create-qr   — TV requests a new QR session
 *   POST /api/pair-qr     — Mobile scans QR and pairs
 *   GET  /api/polling/:id — TV polls until session is paired
 */

const QRCode = require('qrcode');
const store = require('./session.store');

// ─── Config ──────────────────────────────────────────────────────────────────

// Base URL embedded in the QR code (mobile deep-link or web URL)
const QR_BASE_URL = process.env.QR_BASE_URL || 'https://yourapp.com/pair';

// Polling: max wait per long-poll request (ms)
const LONG_POLL_TIMEOUT = 20_000;

// Polling: interval between status checks inside long-poll (ms)
const POLL_INTERVAL = 500;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Wait for a session to reach 'paired' status (long-poll helper).
 * Resolves with the session or null on timeout.
 */
function waitForPairing(sessionId, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const tick = () => {
      const session = store.getSession(sessionId);

      // Session expired or deleted
      if (!session) return resolve(null);

      // Paired → resolve immediately
      if (session.status !== 'pending') return resolve(session);

      // Timed out
      if (Date.now() >= deadline) return resolve(session);

      setTimeout(tick, POLL_INTERVAL);
    };

    tick();
  });
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * POST /api/create-qr
 *
 * Called by the TV when it needs to display a QR code.
 * Returns a base64 PNG QR image + the session ID for polling.
 *
 * Body (optional): { meta: { deviceName: "Living Room TV" } }
 *
 * Response:
 * {
 *   sessionId: string,
 *   qrDataUrl:  string,   ← base64 PNG for <img src="...">
 *   expiresIn:  number,   ← seconds until session expires
 * }
 */
async function createQr(req, res) {
  try {
    const meta = req.body?.meta || {};
    const session = store.createSession(meta);

    // Build the URL mobile will open after scanning
    const pairingUrl = `${QR_BASE_URL}?sessionId=${session.id}`;

    // Generate QR as base64 data URL (TV renders this as <img>)
    const qrDataUrl = await QRCode.toDataURL(session.id, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 300,
      color: { dark: '#000000', light: '#ffffff' },
    });

    return res.status(201).json({
      success: true,
      sessionId: session.id,
      qrDataUrl,
      pairingUrl,          // handy for debugging / manual entry
      expiresIn: 86400,    // 24 hours
    });
  } catch (err) {
    console.error('[createQr] error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create QR session' });
  }
}

/**
 * POST /api/pair-qr
 *
 * Called by the mobile after scanning the QR code.
 * Marks the session as paired and returns a pairToken for future reconnects.
 *
 * Body: { sessionId: string, meta?: { deviceName, platform, ... } }
 *
 * Response:
 * {
 *   pairToken: string,   ← store this in mobile; used for WS reconnect auth
 *   sessionId: string,
 * }
 */
async function pairQr(req, res) {
  try {
    const { sessionId, meta = {} } = req.body;

    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    const existing = store.getSession(sessionId);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Session not found or expired' });
    }

    if (existing.status !== 'pending') {
      return res.status(409).json({
        success: false,
        message: 'Session already paired',
        // Still return token so mobile can reconnect if it lost its copy
        pairToken: existing.pairToken,
        sessionId: existing.id,
      });
    }

    const session = store.pairSession(sessionId, meta);
    if (!session) {
      return res.status(500).json({ success: false, message: 'Pairing failed' });
    }

    return res.status(200).json({
      success: true,
      sessionId: session.id,
      pairToken: session.pairToken,   // ← mobile MUST persist this
      message: 'Pairing successful. Connect WebSocket now.',
    });
  } catch (err) {
    console.error('[pairQr] error:', err);
    return res.status(500).json({ success: false, message: 'Pairing error' });
  }
}

/**
 * GET /api/polling/:sessionId
 *
 * Long-poll endpoint for the TV.
 * Hangs until the session is paired (or times out after ~20 s).
 * TV keeps calling this until status !== 'pending'.
 *
 * Response:
 * {
 *   status: 'pending' | 'paired' | 'connected' | 'disconnected',
 *   sessionId: string,
 * }
 */
async function pollSession(req, res) {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    const session = await waitForPairing(sessionId, LONG_POLL_TIMEOUT);

    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found or expired' });
    }

    return res.status(200).json({
      success: true,
      sessionId: session.id,
      status: session.status,
      pairedAt: session.pairedAt,
    });
  } catch (err) {
    console.error('[pollSession] error:', err);
    return res.status(500).json({ success: false, message: 'Polling error' });
  }
}

/**
 * GET /api/session/:sessionId
 *
 * Lightweight status check (no long-poll) — used after WS reconnect
 * to confirm session is still alive.
 */
async function getSessionStatus(req, res) {
  try {
    const { sessionId } = req.params;
    const session = store.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found or expired' });
    }

    return res.status(200).json({
      success: true,
      sessionId: session.id,
      status: session.status,
      pairedAt: session.pairedAt,
    });
  } catch (err) {
    console.error('[getSessionStatus] error:', err);
    return res.status(500).json({ success: false, message: 'Error fetching session' });
  }
}

module.exports = { createQr, pairQr, pollSession, getSessionStatus };