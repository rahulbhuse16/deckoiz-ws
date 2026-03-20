/**
 * websocket.js
 *
 * Persistent WebSocket server for TV ↔ Mobile communication.
 *
 * ─── Connection URLs ──────────────────────────────────────────────────────────
 *   TV:     ws://host/ws?role=tv&sessionId=<id>
 *   Mobile: ws://host/ws?role=mobile&sessionId=<id>
 *
 *   That's it. No pairToken. No extra auth. Just sessionId.
 *
 * ─── Never-fail guarantee ─────────────────────────────────────────────────────
 *   Any client that supplies a sessionId will ALWAYS be allowed in.
 *   If the session doesn't exist (server restart, file missing, etc.)
 *   it is transparently recreated with the same ID.
 *   Clients never see SESSION_NOT_FOUND or SESSION_EXPIRED.
 *   The only way a session is gone is an explicit logout (deleteSession).
 *
 * ─── Message contract (Mobile → Server → TV) ─────────────────────────────────
 *
 *   Mobile SENDS:
 *     { type: 'message', data: { type: 'artWork'|'collectionQueue'|'aiMagic'|..., payload: {...} } }
 *
 *   TV RECEIVES:
 *     { type: 'message', data: { type: 'artWork', payload: {...} } }
 *
 *   TV reads:
 *     message.data.type    → 'artWork'
 *     message.data.payload → { image, title, ... }
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
 
const HEARTBEAT_INTERVAL = 25_000; // ms — native ping/pong cycle
 
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
 
/**
 * Authenticate an incoming connection.
 *
 * Rules:
 *  - role must be 'tv' or 'mobile'
 *  - sessionId must be present
 *  - session is ALWAYS resolved via getOrCreateSession —
 *    which returns the existing session or recreates it with the same ID.
 *  - This means SESSION_NOT_FOUND and SESSION_EXPIRED can never happen.
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
 
  // getOrCreateSession: never returns null
  // If session exists → return it and touch lastSeenAt
  // If not found    → recreate transparently with the same sessionId
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
      ws.ping(); // native WS ping → triggers 'pong' event on client side
    });
  }, HEARTBEAT_INTERVAL);
 
  wss.on('close', () => clearInterval(interval));
}
 
// ─── Connection handler ───────────────────────────────────────────────────────
 
function onConnection(ws, req) {
  const query = url.parse(req.url, true).query;
 
  // ── 1. Auth — never fails for a valid sessionId ───────────────────────────
  const auth = authenticate(query, ws);
  if (!auth) return; // only fails if role/sessionId missing or invalid role
 
  const { session, role } = auth;
 
  // ── 2. Auto-pair when both sides have connected at least once ─────────────
  //    We treat the first time mobile connects to a session as "pairing".
  //    No token, no QR re-scan — just sessionId.
  if (role === 'mobile' && session.status === 'pending') {
    store.pairSession(session.id);
    console.log(`[WS] Session ${session.id} auto-paired on mobile connect`);
  }
 
  // ── 3. Register socket ────────────────────────────────────────────────────
  const socketId = registerSocket(ws, session.id, role);
  store.updateSessionSocket(session.id, role, socketId);
 
  const connectionCount = getConnectionCount(session.id);
 
  // ── 4. Confirm to THIS client ─────────────────────────────────────────────
  //
  // TV frontend reads:
  //   data.connection_type   → own role ('tv' | 'mobile')
  //   data.connection_count  → total devices online now (>1 = peer is here)
  //
  send(ws, MSG.CONNECTED, {
    connection_type:  role,
    connection_count: connectionCount,
    sessionId:        session.id,
  });
 
  // ── 5. Notify peer that this device joined ────────────────────────────────
  //
  // Peer gets 'connected' with connection_type = the role that JUST joined.
  // TV uses this to set isMobileConnected = true when connection_type = 'mobile'.
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
    `[WS] ${role} connected | session=${session.id} | socket=${socketId} | peers=${connectionCount}`
  );
 
  // ── 6. Native pong ────────────────────────────────────────────────────────
  ws.on('pong', () => {
    ws._isAlive = true;
  });
 
  // ── 7. Message handler ────────────────────────────────────────────────────
  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      send(ws, MSG.ERROR, { code: 'INVALID_JSON', message: 'Message must be valid JSON' });
      return;
    }
 
    // ── Application ping ──────────────────────────────────────────────────
    if (data.type === MSG.PING) {
      ws._isAlive = true;
      send(ws, MSG.PONG, { ts: Date.now() });
      return;
    }
 
    // ── Main relay ────────────────────────────────────────────────────────
    //
    // Mobile sends:  { type: 'message', data: { type: 'artWork', payload: {...} } }
    //                                   ^--- key is 'data'
    // Server relays: { type: 'message', data: { type: 'artWork', payload: {...} } }
    //
    // TV reads:
    //   message.data.type    → 'artWork'
    //   message.data.payload → { image, ... }
    //
    if (data.type === MSG.MESSAGE) {
      const peerWs = getPeerSocket(session.id, role);
      if (peerWs) {
        send(peerWs, MSG.MESSAGE, {
          data: data.data ?? null, // forward data.data — NOT data.payload
        });
      } else {
        // Silently ignore if peer is offline — it will catch up on reconnect
        console.log(`[WS] Peer offline for session ${session.id} — message dropped`);
      }
      return;
    }
 
    // ── rituals_collection shortcut ───────────────────────────────────────
    //
    // Mobile sends: { type: 'rituals_collection', payload: [...] }
    // Forwarded as-is. TV frontend reads data.type === 'rituals_collection'.
    //
    if (data.type === MSG.RITUALS_COLLECTION && Array.isArray(data.payload)) {
      const peerWs = getPeerSocket(session.id, role);
      if (peerWs) {
        send(peerWs, MSG.RITUALS_COLLECTION, { payload: data.payload });
      }
      return;
    }
 
    // ── TV reconnect signal ───────────────────────────────────────────────
    //
    // TV sends { type: 'reconnected' } after its WS reconnects.
    // Forwarded to mobile so it knows TV is back online.
    //
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
 
    // Notify peer — TV frontend listens for type='disconnect', connection_type='mobile'
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
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
 
  startHeartbeat(wss);
 
  wss.on('connection', onConnection);
  wss.on('error', (err) => console.error('[WSS] Server error:', err.message));
 
  console.log('[WSS] WebSocket server attached at /ws');
  return wss;
}
 
module.exports = attachWebSocket;