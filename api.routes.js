/**
 * api.routes.js
 *
 * Mount with:
 *   const apiRoutes = require('./api.routes');
 *   app.use('/api', apiRoutes);
 */

const express = require('express');
const router  = express.Router();
const ctrl    = require('./qr-code.controller');

// ─── QR / Pairing ────────────────────────────────────────────────────────────

// TV: generate a new QR code + session
// Body: { meta?: object }
router.post('/create-qr', ctrl.createQr);

// Mobile: scan QR → pair session, receive pairToken
// Body: { sessionId: string, meta?: object }
router.post('/pair-qr', ctrl.pairQr);

// TV: long-poll until session is paired (hangs ≤ 20 s per request)
// Params: :sessionId
router.get('/polling/:sessionId', ctrl.pollSession);

// Any client: lightweight status check (used after WS reconnect)
// Params: :sessionId
router.get('/session/:sessionId', ctrl.getSessionStatus);

router.delete('/logout/session/:sessionId', ctrl.deleteSessionHandler);


module.exports = router;