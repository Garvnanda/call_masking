const express = require('express');
const http = require('http');
const os = require('os');
const WebSocket = require('ws');
const path = require('path');
const Turn = require('node-turn');

// ---- config (all self-hosted, no third-party services) ----
const PORT = process.env.PORT || 3000;
const TURN_PORT = Number(process.env.TURN_PORT || 3478);
const TURN_USER = process.env.TURN_USER || 'voip';
const TURN_PASS = process.env.TURN_PASS || 'voippass';
// For cross-network use (phones NOT on your Wi-Fi): set EXTERNAL_IP to your
// router's public IPv4 and port-forward TURN_PORT (UDP+TCP) + 49152-65535 UDP
// to this machine. On the same Wi-Fi, leave it unset.
const EXTERNAL_IP = process.env.EXTERNAL_IP || '';

function lanIP() {
  const ifaces = os.networkInterfaces();
  let fallback = '127.0.0.1';
  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (ni.address.startsWith('192.168.')) return ni.address;
      fallback = ni.address;
    }
  }
  return fallback;
}
const LAN = lanIP();
const TURN_HOST = EXTERNAL_IP || LAN;

// ---- self-hosted STUN/TURN ----
try {
  const turn = new Turn({
    authMech: 'long-term',
    credentials: { [TURN_USER]: TURN_PASS },
    listeningPort: TURN_PORT,
    minPort: 49152,
    maxPort: 65535,
    debugLevel: 'ERROR',
    ...(EXTERNAL_IP ? { externalIps: EXTERNAL_IP } : {}),
  });
  turn.start();
  console.log(`TURN/STUN running on ${TURN_HOST}:${TURN_PORT} (udp/tcp)`);
} catch (err) {
  console.error('TURN failed to start (signaling still works):', err.message);
}

// ---- web page + signaling ----
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ICE config handed to the browser at runtime — points only at our own server.
app.get('/config', (_req, res) => {
  res.json({
    iceServers: [
      { urls: `stun:${TURN_HOST}:${TURN_PORT}` },
      { urls: `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, username: TURN_USER, credential: TURN_PASS },
      { urls: `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`, username: TURN_USER, credential: TURN_PASS },
    ],
    iceCandidatePoolSize: 4,
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// code -> array of up to 2 sockets paired under that code.
// ponytail: in-memory only, room forgotten on server restart — fine for a test rig.
const rooms = new Map();

function roomCodeOf(ws) {
  for (const [code, members] of rooms) {
    if (members.includes(ws)) return code;
  }
  return null;
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'join') {
      const code = String(msg.code || '').trim();
      if (!code) return;
      let members = rooms.get(code);
      if (!members) {
        members = [];
        rooms.set(code, members);
      }
      if (members.length >= 2) {
        ws.send(JSON.stringify({ type: 'full' }));
        return;
      }
      members.push(ws);
      console.log(`Room ${code}: ${members.length}/2`);
      if (members.length === 2) {
        // First to join is the answerer, second is the initiator (sends the offer).
        members[0].send(JSON.stringify({ type: 'peer-joined', initiator: false }));
        members[1].send(JSON.stringify({ type: 'peer-joined', initiator: true }));
      }
      return;
    }

    // Any other message is signaling (offer/answer/candidate/bye) — relay it
    // to the other member of this socket's room only.
    const code = roomCodeOf(ws);
    if (!code) return;
    rooms.get(code).forEach((member) => {
      if (member !== ws && member.readyState === WebSocket.OPEN) {
        member.send(raw.toString());
      }
    });
  });

  ws.on('close', () => {
    const code = roomCodeOf(ws);
    if (!code) return;
    const remaining = rooms.get(code).filter((c) => c !== ws);
    if (remaining.length) {
      rooms.set(code, remaining);
      remaining.forEach((m) => {
        if (m.readyState === WebSocket.OPEN) m.send(JSON.stringify({ type: 'peer-left' }));
      });
    } else {
      rooms.delete(code);
    }
    console.log(`Room ${code}: ${remaining.length}/2`);
  });
});

server.listen(PORT, () => {
  console.log(`\nServer running on http://localhost:${PORT}`);
  console.log(`On this LAN:        http://${LAN}:${PORT}`);
  console.log(`ICE config at:      /config  -> turn:${TURN_HOST}:${TURN_PORT}`);
  if (!EXTERNAL_IP) {
    console.log('All 3 devices (this PC + 2 phones) must be on the SAME Wi-Fi.');
    console.log('Cross-network: set EXTERNAL_IP + port-forward. See server.js notes.');
  }
});
