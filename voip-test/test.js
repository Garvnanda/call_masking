// Smoke test: boots server.js on a scratch port, checks static serving + the
// WebSocket relay (A->B forwarded, sender never echoed, close cleans up).
// Run: node test.js   (exit 0 = pass). No framework on purpose.
const assert = require('assert');
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 34567;
const TURN_PORT = 34578;
const BASE = `http://localhost:${PORT}`;

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get(BASE + pathname, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

const wsOpen = (url) =>
  new Promise((resolve, reject) => {
    const s = new WebSocket(url);
    s.once('open', () => resolve(s));
    s.once('error', reject);
  });

const nextMsg = (s) =>
  new Promise((resolve) => s.once('message', (m) => resolve(m.toString())));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), TURN_PORT: String(TURN_PORT) },
    stdio: 'inherit',
  });

  try {
    // wait for listen
    for (let i = 0; i < 50; i++) {
      try { await get('/'); break; } catch { await wait(100); }
    }

    // 1. static: index.html served at /
    const root = await get('/');
    assert.strictEqual(root.status, 200, 'GET / status');
    assert.ok(root.body.includes('2-device voice call'), 'index.html body');

    // 2. static: client.js served
    const cjs = await get('/client.js');
    assert.strictEqual(cjs.status, 200, 'GET /client.js status');
    assert.ok(cjs.body.includes('RTCPeerConnection'), 'client.js body');

    // 3. /config: self-hosted ICE config, no third-party hosts
    const cfg = JSON.parse((await get('/config')).body);
    assert.ok(Array.isArray(cfg.iceServers) && cfg.iceServers.length, '/config iceServers');
    const urls = cfg.iceServers.flatMap((s) => [].concat(s.urls));
    assert.ok(urls.some((u) => u.startsWith('turn:')), '/config has a turn: server');
    assert.ok(
      urls.every((u) => !/google|metered|cloudflare|twilio/.test(u)),
      '/config points only at our own server'
    );

    // 4. self-hosted TURN answers a STUN Binding Request on its UDP port
    await new Promise((resolve, reject) => {
      const d = dgram.createSocket('udp4');
      const b = Buffer.alloc(20);
      b.writeUInt16BE(0x0001, 0);
      b.writeUInt16BE(0x0000, 2);
      b.writeUInt32BE(0x2112a442, 4);
      crypto.randomBytes(12).copy(b, 8);
      const timer = setTimeout(() => { d.close(); reject(new Error('no STUN reply from TURN')); }, 2000);
      d.on('message', (m) => {
        clearTimeout(timer);
        d.close();
        assert.strictEqual(m.readUInt16BE(0), 0x0101, 'STUN Binding Success');
        resolve();
      });
      d.send(b, TURN_PORT, '127.0.0.1');
    });

    // 5. room pairing: same code -> both get peer-joined, second is initiator
    const wsUrl = `ws://localhost:${PORT}`;
    const a = await wsOpen(wsUrl);
    const b = await wsOpen(wsUrl);
    const code = '424242';

    const aJoined = nextMsg(a);
    a.send(JSON.stringify({ type: 'join', code }));
    await wait(50); // A joins alone, gets nothing yet

    const bJoined = nextMsg(b);
    b.send(JSON.stringify({ type: 'join', code }));
    const aMsg = JSON.parse(await aJoined);
    const bMsg = JSON.parse(await bJoined);
    assert.strictEqual(aMsg.type, 'peer-joined', 'A gets peer-joined');
    assert.strictEqual(aMsg.initiator, false, 'first joiner is not initiator');
    assert.strictEqual(bMsg.type, 'peer-joined', 'B gets peer-joined');
    assert.strictEqual(bMsg.initiator, true, 'second joiner is initiator');

    // 6. a 3rd device on the same code is rejected with 'full'
    const c = await wsOpen(wsUrl);
    const cFull = nextMsg(c);
    c.send(JSON.stringify({ type: 'join', code }));
    assert.strictEqual(JSON.parse(await cFull).type, 'full', 'third joiner rejected');
    c.close();

    // 7. relay: message from A reaches only B (same room), not echoed to A
    let aEchoed = false;
    a.on('message', () => (aEchoed = true));
    const gotByB = nextMsg(b);
    a.send(JSON.stringify({ type: 'offer', sdp: 'x' }));
    const received = await gotByB;
    assert.strictEqual(received, '{"type":"offer","sdp":"x"}', 'B receives A message verbatim');
    await wait(100);
    assert.strictEqual(aEchoed, false, 'sender A not echoed its own message');

    // 8. close cleanup: B leaving notifies A with peer-left, no throw
    const aPeerLeft = nextMsg(a);
    b.close();
    assert.strictEqual(JSON.parse(await aPeerLeft).type, 'peer-left', 'A notified on peer leaving');
    a.close();

    // 9. separate room stays isolated (different code, no cross-talk)
    const d = await wsOpen(wsUrl);
    const e = await wsOpen(wsUrl);
    d.send(JSON.stringify({ type: 'join', code: '999999' }));
    e.send(JSON.stringify({ type: 'join', code: '111111' }));
    await wait(100);
    let eGotSomething = false;
    e.on('message', () => (eGotSomething = true));
    d.send(JSON.stringify({ type: 'candidate' }));
    await wait(100);
    assert.strictEqual(eGotSomething, false, 'different room gets nothing');
    d.close();
    e.close();

    console.log('\nALL TESTS PASSED');
    process.exitCode = 0;
  } catch (err) {
    console.error('\nTEST FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    srv.kill();
  }
})();
