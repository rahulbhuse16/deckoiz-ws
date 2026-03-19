/**
 * websocket.js
 *
 * Persistent WebSocket server for TV ↔ Mobile communication.
 *
 * ─── KEY FIX: React Native does NOT respond to native ws.ping() frames ─────
 *   The ws library's built-in heartbeat sends native WebSocket ping frames
 *   and calls ws.terminate() if no native pong comes back. React Native's
 *   WebSocket implementation silently drops native ping frames — it never
 *   sends a native pong. Result: every RN client gets terminated after
 *   one heartbeat cycle with code 1006.
 *
 *   Solution: remove native ws.ping() entirely. Instead, track the timestamp
 *   of the last received message on each socket. If no message arrives within
 *   SOCKET_TIMEOUT, close gracefully with ws.close() (not ws.terminate()).
 *   The mobile client sends { type: 'ping' } every 20 s, which is enough.
 */

const { WebSocketServer, WebSocket } = require('ws');
const url   = require('url');
const store = require('./session.store');

// ─── Config ───────────────────────────────────────────────────────────────────

const HEARTBEAT_CHECK_INTERVAL = 20_000;  // how often we scan sockets (ms)
const SOCKET_TIMEOUT           = 70_000;  // evict if silent for this long (ms)
                                           // mobile pings every 20 s →
                                           // 70 s = 3 missed pings before eviction

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
const socketMap    = new Map();

function registerSocket(ws, sessionId, role) {
  const socketId      = `${role}-${++_socketCounter}`;
  ws._socketId        = socketId;
  ws._sessionId       = sessionId;
  ws._role            = role;
  ws._lastMessageAt   = Date.now();
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

  const session = store.getOrCreateSession(sessionId);
  return { session, role };
}

// ─── Heartbeat (timestamp-based — NO native ws.ping()) ───────────────────────
//
// React Native WebSocket does NOT reply to native WS ping frames, so using
// ws.ping() + ws.terminate() on missed pong will always kill RN clients.
//
// Instead: every HEARTBEAT_CHECK_INTERVAL ms, iterate all open sockets and
// check how long since the last message. Exceeds SOCKET_TIMEOUT → close
// gracefully with ws.close() so the client receives a proper close frame
// (code 1001) and can reconnect cleanly — not the abrupt terminate() that
// produces code 1006.
//
function startHeartbeat(wss) {
  const interval = setInterval(() => {
    const now = Date.now();
    wss.clients.forEach((ws) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      const silentMs = now - (ws._lastMessageAt || now);
      if (silentMs > SOCKET_TIMEOUT) {
        console.log(
          `[WS] No message from ${ws._socketId} for ${Math.round(silentMs / 1000)}s — closing`
        );
        ws.close(1001, 'heartbeat timeout');
      }
    });
  }, HEARTBEAT_CHECK_INTERVAL);

  wss.on('close', () => clearInterval(interval));
}

// ─── Connection handler ───────────────────────────────────────────────────────

function onConnection(ws, req) {
  const query = url.parse(req.url, true).query;

  const auth = authenticate(query, ws);
  if (!auth) return;

  const { session, role } = auth;

  if (role === 'mobile' && session.status === 'pending') {
    store.pairSession(session.id);
    console.log(`[WS] Session ${session.id} auto-paired on mobile connect`);
  }

  const socketId = registerSocket(ws, session.id, role);
  store.updateSessionSocket(session.id, role, socketId);

  const connectionCount = getConnectionCount(session.id);

  send(ws, MSG.CONNECTED, {
    connection_type:  role,
    connection_count: connectionCount,
    sessionId:        session.id,
  });

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

  ws.on('message', (raw) => {
    // THE critical line — refresh the eviction timer on every received message.
    // The mobile app sends { type:'ping' } every 20 s; this resets the 70 s
    // timeout and keeps the connection alive without any native ping frames.
    ws._lastMessageAt = Date.now();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      send(ws, MSG.ERROR, { code: 'INVALID_JSON', message: 'Message must be valid JSON' });
      return;
    }

    if (data.type === MSG.PING) {
      send(ws, MSG.PONG, { ts: Date.now() });
      return;
    }

    if (data.type === MSG.MESSAGE) {
      const peerWs = getPeerSocket(session.id, role);
      if (peerWs) {
        send(peerWs, MSG.MESSAGE, { data: data.data ?? null });
      } else {
        console.log(`[WS] Peer offline for session ${session.id} — message dropped`);
      }
      return;
    }

    if (data.type === MSG.RITUALS_COLLECTION && Array.isArray(data.payload)) {
      const peerWs = getPeerSocket(session.id, role);
      if (peerWs) send(peerWs, MSG.RITUALS_COLLECTION, { payload: data.payload });
      return;
    }

    if (data.type === 'reconnected') {
      const peerWs = getPeerSocket(session.id, role);
      if (peerWs) send(peerWs, 'reconnected', { role, sessionId: session.id });
      return;
    }

    console.warn(`[WS] Unhandled type "${data.type}" from ${role} | session=${session.id}`);
  });

  ws.on('close', (code, reason) => {
    console.log(
      `[WS] ${role} disconnected | session=${session.id} | socket=${socketId} | code=${code} | reason=${reason?.toString()}`
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

  console.log('[WSS] WebSocket server attached at /ws — v3 (timestamp heartbeat, no native ping)');
  return wss;
}

module.exports = attachWebSocket;