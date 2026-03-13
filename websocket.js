/**
 * websocket.js
 *
 * Persistent WebSocket server for TV ↔ Mobile communication.
 *
 * Connection auth (query params on ws:// URL):
 *   TV:     ws://host/ws?role=tv&sessionId=<id>
 *   Mobile: ws://host/ws?role=mobile&sessionId=<id>&pairToken=<token>
 *
 * Persistence strategy:
 *   - TV   reconnects with sessionId alone   (no re-scan needed)
 *   - Mobile reconnects with sessionId + pairToken (no re-scan needed)
 *   - If a client drops, session stays alive for RECONNECT_TTL
 *   - Heartbeat (ping/pong) keeps connections alive through proxies/NATs
 */

const { WebSocketServer, WebSocket } = require('ws');
const url = require('url');
const store = require('./session.store');

// ─── Config ──────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL = 25_000;  // send ping every 25 s
const HEARTBEAT_TIMEOUT  = 10_000;  // close if pong not received within 10 s

// ─── Message type constants ───────────────────────────────────────────────────

const MSG = {
  // Server → Client
  CONNECTED:     'connected',       // auth succeeded
  PEER_JOINED:   'peer_joined',     // the other side connected
  PEER_LEFT:     'peer_left',       // the other side disconnected
  ERROR:         'error',           // auth or runtime error
  PONG:          'pong',            // heartbeat reply

  // Client → Server
  PING:          'ping',            // heartbeat from client
  MESSAGE:       'message',         // arbitrary relay message
};

// ─── Internal socket registry ────────────────────────────────────────────────
// socketMap: socketId → { ws, sessionId, role }

let _socketCounter = 0;
const socketMap = new Map();

function registerSocket(ws, sessionId, role) {
  const socketId = `${role}-${++_socketCounter}`;
  ws._socketId   = socketId;
  ws._sessionId  = sessionId;
  ws._role       = role;
  ws._isAlive    = true;
  socketMap.set(socketId, { ws, sessionId, role });
  return socketId;
}

function unregisterSocket(socketId) {
  socketMap.delete(socketId);
}

function getPeerSocket(sessionId, ownRole) {
  const peerRole = ownRole === 'tv' ? 'mobile' : 'tv';
  for (const { ws, sessionId: sid, role } of socketMap.values()) {
    if (sid === sessionId && role === peerRole && ws.readyState === WebSocket.OPEN) {
      return ws;
    }
  }
  return null;
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

/**
 * Validate an incoming connection.
 * Returns { session, role } on success, or null on failure.
 */
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

  // TV only needs sessionId (it created the session)
  if (role === 'tv') {
    return { session, role };
  }

  

  // Session must be paired (not pending)
  if (session.status === 'pending') {
    sendError(ws, 'Session not yet paired', 'NOT_PAIRED');
    return null;
  }

  return { session, role };
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────

function startHeartbeat(wss) {
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws._isAlive) {
        // Did not respond to last ping → terminate
        ws.terminate();
        return;
      }
      ws._isAlive = false;
      ws.ping();   // native WS ping frame
    });
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => clearInterval(interval));
}

// ─── Connection handler ──────────────────────────────────────────────────────

function onConnection(ws, req) {
  const query = url.parse(req.url, true).query;

  // ── Auth ────────────────────────────────────────────────────────────────
  const auth = authenticate(query, ws);
  if (!auth) return;  // sendError already closed the socket

  const { session, role } = auth;

  // Register socket
  const socketId = registerSocket(ws, session.id, role);
  store.updateSessionSocket(session.id, role, socketId);

  // Confirm connection to this client
  send(ws, MSG.CONNECTED, {
    sessionId: session.id,
    role,
    message: 'Connection established',
  });

  // Notify peer that this side has connected
  const peer = getPeerSocket(session.id, role);
  if (peer) {
    send(peer, MSG.PEER_JOINED, { role, sessionId: session.id });
    // Also tell the just-connected client its peer is already online
    send(ws, MSG.PEER_JOINED, { role: peer._role, sessionId: session.id });
  }

  console.log(`[WS] ${role} connected | session=${session.id} | socket=${socketId}`);

  // ── Pong handler (native ping response) ─────────────────────────────────
  ws.on('pong', () => {
    ws._isAlive = true;
  });

  // ── Message handler ──────────────────────────────────────────────────────
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

    // Relay any other message to peer transparently
    if (data.type === MSG.MESSAGE) {
      const peerWs = getPeerSocket(session.id, role);
      if (peerWs) {
        send(peerWs, MSG.MESSAGE, { from: role, payload: data.payload });
      } else {
        send(ws, MSG.ERROR, { code: 'PEER_OFFLINE', message: 'Peer is not connected' });
      }
      return;
    }
  });

  // ── Disconnect handler ───────────────────────────────────────────────────
  ws.on('close', (code, reason) => {
    console.log(
      `[WS] ${role} disconnected | session=${session.id} | socket=${socketId} | code=${code}`
    );

    unregisterSocket(socketId);
    store.clearSessionSocket(session.id, role);

    // Notify the peer that this side left
    const peerWs = getPeerSocket(session.id, role);
    if (peerWs) {
      send(peerWs, MSG.PEER_LEFT, {
        role,
        sessionId: session.id,
        message: 'Peer disconnected. It may reconnect shortly.',
      });
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] error | session=${session.id} | socket=${socketId}:`, err.message);
  });
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Attach a WebSocket server to an existing HTTP/HTTPS server.
 *
 * Usage:
 *   const { createServer } = require('http');
 *   const app = require('./app');         // Express app
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
    // Optional: enforce origin checking here
    // verifyClient: ({ origin }) => allowedOrigins.includes(origin),
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