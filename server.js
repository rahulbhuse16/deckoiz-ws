/**
 * server.js  —  entry point
 *
 * npm install express ws qrcode
 */

const http          = require('http');
const express       = require('express');
const apiRoutes     = require('./api.routes');
const attachWS      = require('./websocket');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use('/api', apiRoutes);

const httpServer = http.createServer(app);
attachWS(httpServer);   // WebSocket lives at ws://host/ws

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`WebSocket  listening on ws://localhost:${PORT}/ws`);
});