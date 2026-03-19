/**
 * websocket.js
 *
 * Persistent WebSocket server for TV ↔ Mobile communication.
 *
 * ─── Connection URLs ──────────────────────────────────────────────────────────
 *   TV:     ws://host/ws?role=tv&sessionId=<id>
 *   Mobile: ws://host/ws?role=mobile&sessionId=<id>
 *
 * ─── KEY FIX: React Native heartbeat compatibility ────────────────────────────
 *   React Native's WebSocket does NOT respond to native ws.ping() frames.
 *   The old code used ONLY native pings, so every React Native client was
 *   terminated after 2 heartbeat cycles (50 s) with code 1006.
 *
 *   Fix: set ws._isAlive = true on ANY received message, not only on native
 *   pong events. The mobile client sends { type: 'ping' } at the application
 *   level every 20 s — this now keeps the server heartbeat satisfied.
 *
 * ─── Message contract (Mobile → Server → TV) ─────────────────────────────────
 *
 *   Mobile SENDS:
 *     { type: 'message', data: { type: 'artWork'|'collectionQueue'|..., payload: {...} } }
 *
 *   TV RECEIVES:
 *     { type: 'message', data: { type: 'artWork', payload: {...} } }
 *
 * ─── Server → Client events ──────────────────────────────────────────────────
 *   connected   → { type: 'connected',  connection_type, connection_count, sessionId }
 *   disconnect  → { type: 'disconnect', connection_type, sessionId, message }
 *   message     → { type: 'message',    data: { type, payload } }
 *   pong        → { type: 'pong',       ts }
 *   error       → { type: 'error',      code, message }
 */

const { WebSocketServer, WebSocket } = require('ws');
const url   = require('url');
const store = require('./session.store');

// ─── Config ───────────────────────────────────────────────────────────────────

// Native ping/pong cycle. This guards TCP connections that are truly dead
// (e.g. phone goes offline hard). We keep it generous because React Native
// clients supplement with app-level pings (see onmessage handler).
const HEARTBEAT_INTERVAL = 40_000; // ms — increased from 25 s

// ─── Message type constants ───────────────────────────────────────────────────

const MSG = {
  CONNECTED:          'connected',
  DISCONNECT:         'disconnect',
  MESSAGE:            'message',
  RITUALS_COLLECTION: 'rituals_collection',
  PONG:               'pong',
  PING:               'ping',
  ERROR:              'error',
};

// ─── Socket registry ──────────────────────────────────────────────────────────

let _socketCounter = 0;
const socketMap    = new Map(); // socketId → { ws, sessionId, role }

function registerSocket(ws, sessionId, role) {
  const socketId    = `${role}-${++_socketCounter}`;
  ws._socketId      = socketId;
  ws._sessionId     = sessionId;
  ws._role          = role;
  ws._isAlive       = true;
  socketMap.set(socketId, { ws, sessionId, role });
  return socketId;
}

function unregisterSocket(socketId) {
  socketMap.delete(socketId);
}

function getSessionSockets(sessionId, role = null) {
  const results = [];
  for (const entry of socketMap.values()) {
    if (
      entry.sessionId === sessionId &&
      entry.ws.readyState === WebSocket.OPEN &&
      (role === null || entry.role === role)
    ) {
      results.push(entry);
    }
  }
  return results;
}

function getPeerSocket(sessionId, ownRole) {
  const peerRole = ownRole === 'tv' ? 'mobile' : 'tv';
  const peers    = getSessionSockets(sessionId, peerRole);
  return peers.length ? peers[0].ws : null;
}

function getConnectionCount(sessionId) {
  return getSessionSockets(sessionId).length;
}

// ─── Send helpers ─────────────────────────────────────────────────────────────

function send(ws, type, extra = {}) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ...extra }));
}

function sendError(ws, message, code = 'ERROR') {
  send(ws, MSG.ERROR, { code, message });
  ws.close(4000, message);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function authenticate(query, ws) {
  const { role, sessionId } = query;

  if (!role || !sessionId) {
    sendError(ws, 'role and sessionId are required', 'MISSING_PARAMS');
    return null;
  }

  if (role !== 'tv' && role !== 'mobile') {
    sendError(ws, 'role must be "tv" or "mobile"', 'INVALID_ROLE');
    return null;
  }

  // getOrCreateSession: never returns null — recreates transparently if needed
  const session = store.getOrCreateSession(sessionId);
  return { session, role };
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

function startHeartbeat(wss) {
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws._isAlive) {
        console.log(`[WS] Terminating unresponsive socket: ${ws._socketId}`);
        ws.terminate();
        return;
      }
      ws._isAlive = false;
      ws.ping(); // native WS ping frame
    });
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => clearInterval(interval));
}

// ─── Connection handler ───────────────────────────────────────────────────────

function onConnection(ws, req) {
  const query = url.parse(req.url, true).query;

  // ── 1. Auth ───────────────────────────────────────────────────────────────
  const auth = authenticate(query, ws);
  if (!auth) return;

  const { session, role } = auth;

  // ── 2. Auto-pair ──────────────────────────────────────────────────────────
  if (role === 'mobile' && session.status === 'pending') {
    store.pairSession(session.id);
    console.log(`[WS] Session ${session.id} auto-paired on mobile connect`);
  }

  // ── 3. Register socket ────────────────────────────────────────────────────
  const socketId = registerSocket(ws, session.id, role);
  store.updateSessionSocket(session.id, role, socketId);

  const connectionCount = getConnectionCount(session.id);

  // ── 4. Confirm to THIS client ─────────────────────────────────────────────
  send(ws, MSG.CONNECTED, {
    connection_type:  role,
    connection_count: connectionCount,
    sessionId:        session.id,
  });

  // ── 5. Notify peer ────────────────────────────────────────────────────────
  const peer = getPeerSocket(session.id, role);
  if (peer) {
    send(peer, MSG.CONNECTED, {
      connection_type:  role,
      connection_count: connectionCount,
      sessionId:        session.id,
    });
  }

  console.log(
    `[WS] ${role} connected | session=${session.id} | socket=${socketId} | peers=${connectionCount}`
  );

  // ── 6. Native pong ────────────────────────────────────────────────────────
  ws.on('pong', () => {
    ws._isAlive = true;
  });

  // ── 7. Message handler ────────────────────────────────────────────────────
  ws.on('message', (raw) => {
    // KEY FIX (Bug 1): Mark this socket alive on ANY message.
    // React Native does NOT auto-reply to native ws.ping() frames, so the
    // native pong event never fires on mobile clients. Without this line,
    // the server's heartbeat marks every React Native socket as dead after
    // one missed native pong cycle and calls ws.terminate() → code 1006.
    // By treating any received message as a keep-alive signal we ensure
    // the heartbeat never falsely evicts a healthy React Native connection.
    ws._isAlive = true;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      send(ws, MSG.ERROR, { code: 'INVALID_JSON', message: 'Message must be valid JSON' });
      return;
    }

    // ── Application ping ──────────────────────────────────────────────────
    if (data.type === MSG.PING) {
      send(ws, MSG.PONG, { ts: Date.now() });
      return;
    }

    // ── Main relay ────────────────────────────────────────────────────────
    if (data.type === MSG.MESSAGE) {
      const peerWs = getPeerSocket(session.id, role);
      if (peerWs) {
        send(peerWs, MSG.MESSAGE, { data: data.data ?? null });
      } else {
        console.log(`[WS] Peer offline for session ${session.id} — message dropped`);
      }
      return;
    }

    // ── rituals_collection shortcut ───────────────────────────────────────
    if (data.type === MSG.RITUALS_COLLECTION && Array.isArray(data.payload)) {
      const peerWs = getPeerSocket(session.id, role);
      if (peerWs) {
        send(peerWs, MSG.RITUALS_COLLECTION, { payload: data.payload });
      }
      return;
    }

    // ── TV reconnect signal ───────────────────────────────────────────────
    if (data.type === 'reconnected') {
      const peerWs = getPeerSocket(session.id, role);
      if (peerWs) {
        send(peerWs, 'reconnected', { role, sessionId: session.id });
      }
      return;
    }

    console.warn(`[WS] Unhandled type "${data.type}" from ${role} | session=${session.id}`);
  });

  // ── 8. Disconnect handler ─────────────────────────────────────────────────
  ws.on('close', (code) => {
    console.log(
      `[WS] ${role} disconnected | session=${session.id} | socket=${socketId} | code=${code}`
    );

    unregisterSocket(socketId);
    store.clearSessionSocket(session.id, role);

    const peerWs = getPeerSocket(session.id, role);
    if (peerWs) {
      send(peerWs, MSG.DISCONNECT, {
        connection_type: role,
        sessionId:       session.id,
        message:         'Peer disconnected. It will reconnect automatically.',
      });
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error | session=${session.id} | socket=${socketId} | ${err.message}`);
  });
}

// ─── Factory ──────────────────────────────────────────────────────────────────

function attachWebSocket(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  startHeartbeat(wss);

  wss.on('connection', onConnection);
  wss.on('error', (err) => console.error('[WSS] Server error:', err.message));

  console.log('[WSS] WebSocket server attached at /ws');
  return wss;
}

module.exports = attachWebSocket;