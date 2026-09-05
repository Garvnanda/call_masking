# Minimal WebRTC voice call — 2-device test build

Goal: a bare web page with one "Call" button. Open it on two different
devices (2 PCs, 2 phones, or one of each). Click Call on one. Real-time
two-way voice flows directly between them. Nothing else — no accounts,
no UI beyond call/hang up.

## How it works (quick recap)

Three pieces, three jobs:

1. **Signaling server** — a small server both devices connect to first.
   It doesn't touch audio at all — it just relays a few JSON messages
   (the "here's how to reach me" handshake) between the two devices.
2. **STUN server** — a public, free server (`stun.l.google.com`) that
   tells each device its own reachable network address. This is the
   one external dependency we're not self-hosting, because it's free,
   stateless, and doesn't touch your audio or any of your data — it's
   only used during connection setup.
3. **WebRTC** (built into every modern browser) — once both sides know
   how to reach each other, it opens a direct, encrypted audio
   connection between the two devices. Your signaling server is not
   involved in the actual call audio.

No TURN server in this version — if it doesn't connect, see
Troubleshooting below for why and what that means.

---

## Prerequisites

- [Node.js](https://nodejs.org) installed (v18+) on the machine that will run the server
- A code editor
- Two devices to test with, on the same Wi-Fi to start (simplest case)
- [ngrok](https://ngrok.com/download) — free account, no card needed — for exposing the server over HTTPS (explained in Step 4, and why it's required)

---

## Step 1 — Project setup

```bash
mkdir voip-test
cd voip-test
npm init -y
npm install express ws
mkdir public
```

Folder structure you should end up with:

```
voip-test/
  server.js
  package.json
  public/
    index.html
    client.js
```

---

## Step 2 — The signaling server

Create `server.js` in the project root:

```javascript
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let clients = [];

wss.on('connection', (ws) => {
  clients.push(ws);
  console.log(`Client connected. Total: ${clients.length}`);

  ws.on('message', (message) => {
    // Relay whatever this client sent to every OTHER connected client.
    // With only 2 devices ever connecting, this is all the "routing" we need.
    clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message.toString());
      }
    });
  });

  ws.on('close', () => {
    clients = clients.filter((c) => c !== ws);
    console.log(`Client disconnected. Total: ${clients.length}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
```

What this does: serves your web page as static files, AND runs a
WebSocket server on the same port. Any message one browser tab sends
gets forwarded to the other connected tab. That's the entire signaling
layer — it never looks at or understands the messages, just relays them.

---

## Step 3 — The client page

Create `public/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>VoIP test</title>
  <style>
    body { font-family: sans-serif; text-align: center; margin-top: 60px; }
    button { font-size: 20px; padding: 12px 28px; margin: 8px; }
    #status { margin-top: 16px; color: #555; }
  </style>
</head>
<body>
  <h2>2-device voice call test</h2>
  <button id="callBtn" disabled>Call</button>
  <button id="hangupBtn" disabled>Hang up</button>
  <p id="status">Loading mic...</p>
  <audio id="remoteAudio" autoplay playsinline></audio>
  <script src="client.js"></script>
</body>
</html>
```

Create `public/client.js`:

```javascript
const configuration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

const callBtn = document.getElementById('callBtn');
const hangupBtn = document.getElementById('hangupBtn');
const statusEl = document.getElementById('status');
const remoteAudio = document.getElementById('remoteAudio');

let ws;
let pc;
let localStream;

async function init() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    statusEl.textContent = 'Mic ready. Connecting to server...';
  } catch (err) {
    statusEl.textContent = 'Mic access denied or unavailable: ' + err.message;
    return;
  }
  connectSignaling();
}

function connectSignaling() {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProtocol}//${location.host}`);

  ws.onopen = () => {
    statusEl.textContent = 'Connected. Ready to call.';
    callBtn.disabled = false;
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'offer') {
      await handleOffer(data);
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
    } else if (data.type === 'candidate' && pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('Error adding ICE candidate', err);
      }
    }
  };

  ws.onclose = () => {
    statusEl.textContent = 'Disconnected from server';
    callBtn.disabled = true;
  };
}

function createPeerConnection() {
  pc = new RTCPeerConnection(configuration);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
    }
  };

  pc.ontrack = (event) => {
    remoteAudio.srcObject = event.streams[0];
    statusEl.textContent = 'In call';
  };

  pc.onconnectionstatechange = () => {
    console.log('Connection state:', pc.connectionState);
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      statusEl.textContent = 'Call disconnected';
    }
  };

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
}

async function handleOffer(offer) {
  createPeerConnection();
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify(pc.localDescription));
  callBtn.disabled = true;
  hangupBtn.disabled = false;
}

callBtn.onclick = async () => {
  createPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify(pc.localDescription));
  statusEl.textContent = 'Calling...';
  callBtn.disabled = true;
  hangupBtn.disabled = false;
};

hangupBtn.onclick = () => {
  if (pc) {
    pc.close();
    pc = null;
  }
  statusEl.textContent = 'Call ended';
  callBtn.disabled = false;
  hangupBtn.disabled = true;
};

init();
```

What this does, in order: asks for mic permission → connects to the
signaling server over WebSocket → whichever device clicks "Call" first
creates an SDP offer and sends it → the other device receives it,
creates an SDP answer, sends it back → both sides trade ICE candidates
as they're discovered → once negotiation completes, `ontrack` fires and
the remote audio starts playing.

---

## Step 4 — Run it, and why you need HTTPS for a 2-device test

```bash
node server.js
```

This works fine at `http://localhost:3000` on the machine running it —
but here's the part that trips people up: **browsers block microphone
access on any page that isn't a "secure context."** `localhost` counts
as secure. `http://192.168.1.23:3000` (your PC's plain local-network
address) does **not** — the second device's `getUserMedia` call will
be silently rejected there. You cannot skip this step.

Fix: tunnel your local server through HTTPS with ngrok.

```bash
ngrok http 3000
```

This prints an HTTPS URL like `https://a1b2c3d4.ngrok-free.app`. Open
**that exact URL** on both devices (not the local IP). ngrok also
solves the "two different Wi-Fi networks" case for free — your phone
can be on mobile data and it'll still reach the tunnel.

(If both devices are genuinely on the same machine's `localhost`, e.g.
two browser tabs for a quick sanity check, you can skip ngrok and just
use `http://localhost:3000` on both.)

---

## Step 5 — Test it

1. Open the ngrok HTTPS URL on Device A. Allow microphone access when prompted.
2. Open the same URL on Device B. Allow microphone access.
3. Both should show "Connected. Ready to call."
4. Click **Call** on Device A.
5. Device B's status should switch to "In call" within a second or two, and you should hear Device A's mic through Device B's speaker/headphones, and vice versa.
6. Click **Hang up** on either side to end it.

---

## Troubleshooting

- **Mic permission denied on the second device** — almost always the
  HTTPS/secure-context issue above. Confirm you're on the `ngrok` URL,
  not a local IP.
- **Nothing happens after clicking Call** — open the browser console
  (F12) on both devices and check `pc.connectionState` logs. If it
  gets stuck on `checking` and never reaches `connected`, that's an
  ICE negotiation failure — see next point.
- **Connects on the same Wi-Fi but fails over mobile data / different
  networks** — this is the TURN-server gap mentioned earlier. STUN
  alone can't get through every NAT/firewall combination (carrier-grade
  NAT on mobile networks is a common culprit). This setup will work
  reliably on the same LAN and often across networks too, but not
  guaranteed on every network. Adding a TURN relay (`coturn`,
  self-hosted) closes this gap — worth doing once this basic version
  works, not before.
- **Loud echo / feedback squeal** — only happens if you're testing two
  tabs on the *same* physical device with speakers on. Use headphones
  on at least one side, or test on two separate physical devices.
- **No sound on iOS Safari even though "In call" shows** — iOS Safari
  is strict about audio autoplay; if it doesn't start automatically,
  add a one-time tap-to-enable-audio step (any user gesture after the
  call connects unlocks it).
- **WebSocket won't connect** — check that port 3000 isn't blocked by
  a local firewall, and that `server.js` is still running in the
  terminal.

---

## What's deliberately left out of this version

- **TURN server** — not included yet (see Troubleshooting). Add
  `coturn` once this works, if you hit connectivity failures across
  networks.
- **Reconnection handling** — if the WebSocket drops mid-call, nothing
  auto-recovers. Fine for a test, not for real use.
- **Room/pairing system** — this version relays to "whoever else is
  connected," which only makes sense with exactly 2 clients. A third
  browser tab connecting would break it.
- **Video** — audio only, on purpose, per what you asked for. Adding
  video later is a small change (`video: true` in `getUserMedia`, plus
  a `<video>` element instead of `<audio>`).
