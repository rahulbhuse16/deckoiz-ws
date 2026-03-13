/**
 * websocket.js
 *
 * Persistent WebSocket server for TV ↔ Mobile communication.
 *
 * Connection auth (query params on ws:// URL):
 *   TV:     ws://host/ws?role=tv&sessionId=<id>
 *   Mobile: ws://host/ws?role=mobile&sessionId=<id>&pairToken=<token>
 *
 * Message format is aligned with the React Native frontend expectations:
 *
 *   connected   → { type: 'connected',   connection_type, connection_count }
 *   disconnect  → { type: 'disconnect',  connection_type }
 *   message     → { type: 'message',     data: <payload from sender> }
 *   error       → { type: 'error',       code, message }
 *   pong        → { type: 'pong',        ts }
 */

const { WebSocketServer, WebSocket } = require('ws');
const url = require('url');
const store = require('./session.store');

// ─── Config ──────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL = 25_000; // send ping every 25 s
const HEARTBEAT_TIMEOUT  = 10_000; // close if pong not received within 10 s

// ─── Message type constants ───────────────────────────────────────────────────

const MSG = {
  // Server → Client  (names match what the RN frontend listens for)
  CONNECTED:  'connected',   // auth succeeded / peer joined
  DISCONNECT: 'disconnect',  // peer disconnected  ← was 'peer_left'
  ERROR:      'error',       // auth or runtime error
  PONG:       'pong',        // heartbeat reply

  // Client → Server
  PING:    'ping',    // heartbeat from client
  MESSAGE: 'message', // arbitrary relay message
};

// ─── Internal socket registry ─────────────────────────────────────────────────

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

/** Return all open sockets belonging to a session (optionally filtered by role). */
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

/** Return the first open peer socket (opposite role) for a session. */
function getPeerSocket(sessionId, ownRole) {
  const peerRole = ownRole === 'tv' ? 'mobile' : 'tv';
  const peers = getSessionSockets(sessionId, peerRole);
  return peers.length ? peers[0].ws : null;
}

/** Count all open sockets in a session. */
function getConnectionCount(sessionId) {
  return getSessionSockets(sessionId).length;
}

// ─── Send helpers ─────────────────────────────────────────────────────────────

function send(ws, type, payload = {}) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ...payload }));
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

  if (role === 'tv') {
    return { session, role };
  }

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

  // ── Auth ──────────────────────────────────────────────────────────────────
  const auth = authenticate(query, ws);
  if (!auth) return;

  const { session, role } = auth;

  // Register the socket BEFORE counting so this socket is included in the count
  const socketId = registerSocket(ws, session.id, role);
  store.updateSessionSocket(session.id, role, socketId);

  const connectionCount = getConnectionCount(session.id); // includes self

  // ── Confirm connection to THIS client ─────────────────────────────────────
  //
  // Frontend reads:
  //   data.type === 'connected'
  //   data.connection_type  → 'tv' | 'mobile'
  //   data.connection_count → total devices in session (>1 means peer is online)
  //
  send(ws, MSG.CONNECTED, {
    connection_type:  role,
    connection_count: connectionCount,
    sessionId: session.id,
  });

  // ── Notify peer that a new device joined ──────────────────────────────────
  //
  // The peer also receives a 'connected' event so it can update isMobileConnected.
  // connection_type is the role of the device that JUST joined (not the receiver's role).
  //
  const peer = getPeerSocket(session.id, role);
  if (peer) {
    const updatedCount = getConnectionCount(session.id); // still the same value
    send(peer, MSG.CONNECTED, {
      connection_type:  role,          // the role that just joined
      connection_count: updatedCount,
      sessionId: session.id,
    });
  }

  console.log(
    `[WS] ${role} connected | session=${session.id} | socket=${socketId} | devices=${connectionCount}`
  );

  // ── Pong handler (native ping frame response) ─────────────────────────────
  ws.on('pong', () => {
    ws._isAlive = true;
  });

  // ── Message handler ───────────────────────────────────────────────────────
  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      send(ws, MSG.ERROR, { code: 'INVALID_JSON', message: 'Message must be JSON' });
      return;
    }

    // Application-level ping → pong
    if (data.type === MSG.PING) {
      ws._isAlive = true;
      send(ws, MSG.PONG, { ts: Date.now() });
      return;
    }

    // ── Relay message to peer ──────────────────────────────────────────────
    //
    // Frontend (TV side) reads relayed messages as:
    //   message.data?.data?.type  (e.g. 'collectionQueue', 'aiMagic', 'artWork' …)
    //   message.data?.data?.payload
    //
    // So the TV must receive:  { type: 'message', data: <what mobile sent as payload> }
    //
    // Mobile should send:
    //   { type: 'message', payload: { data: { type: 'collectionQueue', payload: {...} } } }
    //            ↑ outer type for server routing    ↑ this becomes message.data on TV
    //
    if (data.type === MSG.MESSAGE) {
      const peerWs = getPeerSocket(session.id, role);
      if (peerWs) {
        // Wrap payload under `data` so TV frontend can read message.data.data.type
        send(peerWs, MSG.MESSAGE, { data: data.payload ?? null });
      } else {
        send(ws, MSG.ERROR, { code: 'PEER_OFFLINE', message: 'Peer is not connected' });
      }
      return;
    }

    // ── rituals_collection shortcut ────────────────────────────────────────
    //
    // Mobile can send top-level ritual updates directly:
    //   { type: 'rituals_collection', payload: [...] }
    // The server forwards them to TV in the same shape (frontend handles this at
    // the top of processWebSocketMessage before it reaches processIndividualMessage).
    //
    if (data.type === 'rituals_collection' && Array.isArray(data.payload)) {
      const peerWs = getPeerSocket(session.id, role);
      if (peerWs) {
        send(peerWs, 'rituals_collection', { payload: data.payload });
      }
      return;
    }

    // Unknown message types — log and ignore
    console.warn(`[WS] Unknown message type "${data.type}" from ${role} | session=${session.id}`);
  });

  // ── Disconnect handler ────────────────────────────────────────────────────
  ws.on('close', (code, reason) => {
    console.log(
      `[WS] ${role} disconnected | session=${session.id} | socket=${socketId} | code=${code}`
    );

    unregisterSocket(socketId);
    store.clearSessionSocket(session.id, role);

    // Notify peer with 'disconnect' (what the RN frontend listens for)
    //
    // Frontend reads:
    //   data.type === 'disconnect'
    //   data.connection_type → role of the device that left
    //
    const peerWs = getPeerSocket(session.id, role);
    if (peerWs) {
      send(peerWs, MSG.DISCONNECT, {
        connection_type: role,           // role that just left
        sessionId: session.id,
        message: 'Peer disconnected. It may reconnect shortly.',
      });
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] error | session=${session.id} | socket=${socketId}:`, err.message);
  });
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Attach a WebSocket server to an existing HTTP/HTTPS server.
 *
 * Usage:
 *   const { createServer } = require('http');
 *   const app = require('./app');
 *   const attachWebSocket = require('./websocket');
 *
 *   const httpServer = createServer(app);
 *   attachWebSocket(httpServer);
 *   httpServer.listen(3000);
 */
function attachWebSocket(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
  });

  startHeartbeat(wss);
  wss.on('connection', onConnection);
  wss.on('error', (err) => {
    console.error('[WSS] server error:', err.message);
  });

  console.log('[WSS] WebSocket server attached at /ws');
  return wss;
}

module.exports = attachWebSocket;