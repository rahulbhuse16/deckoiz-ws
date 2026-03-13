/**
 * websocket.js
 *
 * Persistent WebSocket server for TV ↔ Mobile communication.
 *
 * ─── Connection URLs ──────────────────────────────────────────────────────────
 *   TV:     ws://host/ws?role=tv&sessionId=<id>
 *   Mobile: ws://host/ws?role=mobile&sessionId=<id>
 *
 * ─── Message contract (Mobile → Server → TV) ─────────────────────────────────
 *
 *  Mobile SENDS:
 *    { type: 'message', data: { type: 'artWork' | 'collectionQueue' | 'aiMagic' | ..., payload: {...} } }
 *
 *  TV RECEIVES (server forwards data.data transparently):
 *    { type: 'message', data: { type: 'artWork', payload: {...} } }
 *
 *  TV reads it as:
 *    message.data.data.type    → 'artWork'
 *    message.data.data.payload → { image, title, ... }
 *
 * ─── Server → Client events ──────────────────────────────────────────────────
 *   connected   → { type: 'connected',  connection_type: 'tv'|'mobile', connection_count: number, sessionId }
 *   disconnect  → { type: 'disconnect', connection_type: 'tv'|'mobile', sessionId, message }
 *   message     → { type: 'message',    data: { type, payload } }
 *   error       → { type: 'error',      code, message }
 *   pong        → { type: 'pong',       ts }
 *
 * ─── rituals_collection shortcut ─────────────────────────────────────────────
 *   Mobile can also send:
 *     { type: 'rituals_collection', payload: [...] }
 *   Server forwards to TV as-is (TV handles it at top of processWebSocketMessage).
 */

const { WebSocketServer, WebSocket } = require('ws');
const url   = require('url');
const store = require('./session.store');

// ─── Config ───────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL = 25_000; // ping every 25 s

// ─── Message type constants ───────────────────────────────────────────────────

const MSG = {
  CONNECTED:          'connected',           // auth confirmed + peer-join notification
  DISCONNECT:         'disconnect',          // peer left  (was wrongly 'peer_left' before)
  MESSAGE:            'message',             // relayed payload
  RITUALS_COLLECTION: 'rituals_collection',  // ritual shortcut relay
  ERROR:              'error',
  PING:               'ping',
  PONG:               'pong',
};

// ─── Socket registry ──────────────────────────────────────────────────────────

let _socketCounter = 0;
const socketMap = new Map(); // socketId → { ws, sessionId, role }

function registerSocket(ws, sessionId, role) {
  const socketId = `${role}-${++_socketCounter}`;
  ws._socketId  = socketId;
  ws._sessionId = sessionId;
  ws._role      = role;
  ws._isAlive   = true;
  socketMap.set(socketId, { ws, sessionId, role });
  return socketId;
}

function unregisterSocket(socketId) {
  socketMap.delete(socketId);
}

/**
 * Return all OPEN sockets for a session.
 * Pass role = 'tv' | 'mobile' to filter, or null for all.
 */
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

/** First open peer socket (opposite role). */
function getPeerSocket(sessionId, ownRole) {
  const peerRole = ownRole === 'tv' ? 'mobile' : 'tv';
  const peers    = getSessionSockets(sessionId, peerRole);
  return peers.length ? peers[0].ws : null;
}

/** Total open sockets in a session (TV + Mobile combined). */
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

  const session = store.getSession(sessionId);
  if (!session) {
    sendError(ws, 'Session not found or expired', 'SESSION_NOT_FOUND');
    return null;
  }

  // TV only needs a valid sessionId (it created the session)
  if (role === 'tv') {
    return { session, role };
  }

  // Mobile requires a paired session
  if (session.status === 'pending') {
    sendError(ws, 'Session not yet paired', 'NOT_PAIRED');
    return null;
  }

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
      ws.ping(); // native WebSocket ping frame — triggers 'pong' event on client
    });
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => clearInterval(interval));
}

// ─── Connection handler ───────────────────────────────────────────────────────

function onConnection(ws, req) {
  const query = url.parse(req.url, true).query;

  // ── 1. Authenticate ───────────────────────────────────────────────────────
  const auth = authenticate(query, ws);
  if (!auth) return; // sendError already closed the socket

  const { session, role } = auth;

  // ── 2. Register socket ────────────────────────────────────────────────────
  // Register BEFORE counting so this socket is included in the total.
  const socketId = registerSocket(ws, session.id, role);
  store.updateSessionSocket(session.id, role, socketId);

  const connectionCount = getConnectionCount(session.id);

  // ── 3. Confirm connection to THIS client ──────────────────────────────────
  //
  // Frontend (TV) reads:
  //   data.type              → 'connected'
  //   data.connection_type   → own role ('tv' | 'mobile')
  //   data.connection_count  → total devices in session right now
  //
  send(ws, MSG.CONNECTED, {
    connection_type:  role,
    connection_count: connectionCount,
    sessionId:        session.id,
  });

  // ── 4. Notify peer that this device joined ────────────────────────────────
  //
  // Peer also receives a 'connected' event so it can update isMobileConnected.
  //   data.connection_type = the role that JUST joined (not the receiver's role)
  //
  const peer = getPeerSocket(session.id, role);
  if (peer) {
    send(peer, MSG.CONNECTED, {
      connection_type:  role,            // who just joined
      connection_count: connectionCount,
      sessionId:        session.id,
    });
  }

  console.log(
    `[WS] ${role} connected | session=${session.id} | socket=${socketId} | total=${connectionCount}`
  );

  // ── 5. Native pong (response to server's ws.ping()) ───────────────────────
  ws.on('pong', () => {
    ws._isAlive = true;
  });

  // ── 6. Message handler ────────────────────────────────────────────────────
  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      send(ws, MSG.ERROR, { code: 'INVALID_JSON', message: 'Message must be valid JSON' });
      return;
    }

    // ── 6a. Application-level ping → pong ─────────────────────────────────
    if (data.type === MSG.PING) {
      ws._isAlive = true;
      send(ws, MSG.PONG, { ts: Date.now() });
      return;
    }

    // ── 6b. Main relay ─────────────────────────────────────────────────────
    //
    // Mobile sends:
    //   {
    //     type: 'message',
    //     data: {                    ← key is 'data', NOT 'payload'
    //       type: 'artWork',
    //       payload: { image, title, glowInnerColors, ... }
    //     }
    //   }
    //
    // Server forwards data.data (the inner object) under the key 'data':
    //   { type: 'message', data: { type: 'artWork', payload: {...} } }
    //
    // TV frontend then reads:
    //   message.data?.data?.type     → 'artWork'       ✓
    //   message.data?.data?.payload  → { image, ... }  ✓
    //
    // Same structure works for ALL feature types:
    //   'collectionQueue', 'aiMagic', 'artWork', 'reconnect', etc.
    //
    if (data.type === MSG.MESSAGE) {
      const peerWs = getPeerSocket(session.id, role);
      if (peerWs) {
        send(peerWs, MSG.MESSAGE, {
          data: data.data ?? null,   // ← CRITICAL: forward data.data, not data.payload
        });
      } else {
        send(ws, MSG.ERROR, { code: 'PEER_OFFLINE', message: 'Peer is not connected' });
      }
      return;
    }

    // ── 6c. rituals_collection shortcut ───────────────────────────────────
    //
    // Mobile can push ritual schedules without the 'message' wrapper:
    //   { type: 'rituals_collection', payload: [...] }
    //
    // TV frontend handles this at the TOP of processWebSocketMessage:
    //   if (data.type === 'rituals_collection' && Array.isArray(data.payload))
    //
    if (data.type === MSG.RITUALS_COLLECTION && Array.isArray(data.payload)) {
      const peerWs = getPeerSocket(session.id, role);
      if (peerWs) {
        send(peerWs, MSG.RITUALS_COLLECTION, { payload: data.payload });
      }
      return;
    }

    // ── 6d. Reconnect signal ──────────────────────────────────────────────
    //
    // TV sends { type: 'reconnected' } after its WS reconnects.
    // Forward to mobile so it knows TV is back online.
    //
    if (data.type === 'reconnected') {
      const peerWs = getPeerSocket(session.id, role);
      if (peerWs) {
        send(peerWs, 'reconnected', { role, sessionId: session.id });
      }
      return;
    }

    console.warn(
      `[WS] Unhandled message type "${data.type}" from ${role} | session=${session.id}`
    );
  });

  // ── 7. Disconnect handler ─────────────────────────────────────────────────
  ws.on('close', (code) => {
    console.log(
      `[WS] ${role} disconnected | session=${session.id} | socket=${socketId} | code=${code}`
    );

    unregisterSocket(socketId);
    store.clearSessionSocket(session.id, role);

    // Tell peer with 'disconnect' event (what the RN frontend listens for).
    //
    // Frontend reads:
    //   data.type            → 'disconnect'
    //   data.connection_type → 'mobile' | 'tv'  (who left)
    //
    const peerWs = getPeerSocket(session.id, role);
    if (peerWs) {
      send(peerWs, MSG.DISCONNECT, {
        connection_type: role,
        sessionId:       session.id,
        message:         'Peer disconnected. It may reconnect shortly.',
      });
    }
  });

  ws.on('error', (err) => {
    console.error(
      `[WS] Socket error | session=${session.id} | socket=${socketId} | ${err.message}`
    );
  });
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Attach a WebSocket server to an existing HTTP/HTTPS server.
 *
 * Usage:
 *   const http = require('http');
 *   const app  = require('./app');
 *   const attachWebSocket = require('./websocket');
 *
 *   const server = http.createServer(app);
 *   attachWebSocket(server);
 *   server.listen(3000);
 */
function attachWebSocket(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    path:   '/ws',
  });

  startHeartbeat(wss);

  wss.on('connection', onConnection);

  wss.on('error', (err) => {
    console.error('[WSS] Server error:', err.message);
  });

  console.log('[WSS] WebSocket server attached at /ws');
  return wss;
}

module.exports = attachWebSocket;