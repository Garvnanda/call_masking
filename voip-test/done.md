# Done

What's actually built, working, and tested in `voip-test/`.

## Files

```
voip-test/
  server.js            Express static server + WebSocket signaling + self-hosted TURN/STUN
  package.json          npm start / npm test
  test.js               automated smoke test (no framework)
  public/
    index.html           page: show-code / enter-code lobby + hang up
    client.js             WebRTC + pairing + ICE diagnostics
  deploy/
    voip.env              env template for a cloud/VM deploy
    voip.service           systemd unit (auto-restart, survives reboot)
    setup.sh               one-shot VM provisioning script (unused — see idea.md, cross-network deploy stalled on requiring a card)
```

## What it does

1. Open the page on two devices. Mic permission requested up front.
2. One device clicks **Show code** → a random 6-digit code appears.
3. The other clicks **Enter code**, types it, hits **Connect**.
4. Server pairs the two sockets under that code (`server.js` `rooms` map).
   The second device to join is told it's the initiator and auto-sends the
   WebRTC offer; the call starts automatically — no separate Call button.
5. Audio flows directly between the two devices (or through the self-hosted
   TURN relay if a direct path isn't reachable) once ICE finishes.
6. **Hang up** on either side ends the call and notifies the other side
   (`bye` message); if a device just disconnects, the other gets
   `peer-left` and resets to the lobby.
7. Status line shows live state: mic ready → connected to server → paired →
   connecting media → `In call (path: host <-> host)` /
   `(path: relay <-> relay)` etc., so you can see exactly which ICE path
   was used.

## Self-hosted STUN/TURN

`server.js` starts a `node-turn` instance in-process (no external service).
The browser fetches `/config` at load time to get its ICE server list —
that endpoint only ever returns `stun:`/`turn:` URLs pointing at this same
server, nothing third-party.

Env vars (defaults shown):
- `PORT=3000` — web + signaling port
- `TURN_PORT=3478` — STUN/TURN port
- `TURN_USER=voip`, `TURN_PASS=voippass` — TURN credentials
- `EXTERNAL_IP` — set this to a public IP if the TURN server needs to be
  reachable from outside the LAN it's running on (unset = same-LAN only)

## iOS Safari audio-autoplay handling

`remoteAudio.play()` is attempted on `ontrack`; if the browser blocks
autoplay, the page falls back to "tap anywhere to enable audio" and unlocks
on the next click — one-time only.

## Known, deliberate limits

- **Same-network only, out of the box.** Verified working on the same
  Wi-Fi/LAN. Cross-network (e.g. one phone on mobile data) needs the
  TURN server to have a real public IP — see `idea.md` for why, and the
  chat history for the exact check-CGNAT / check-IPv6 / port-forward steps
  if you want to pursue that further. `deploy/` has a ready VM-provisioning
  script for that path, parked because the free-tier clouds that support
  raw UDP all require a card.
- **In-memory rooms.** Pairing codes are forgotten on server restart — fine
  for a test rig, not for a real product.
- **No reconnection handling.** If the WebSocket drops mid-call, nothing
  auto-recovers.
- **Exactly one call at a time per room**; a third device on the same code
  gets rejected (`full`).

## Tests

`npm test` (`test.js`) — boots the real server on a scratch port and checks,
end to end, with real sockets (no mocks):

1. `GET /` serves the page.
2. `GET /client.js` serves the client script.
3. `GET /config` returns ICE servers, includes a `turn:` entry, and — the
   thing that actually matters here — every URL points at our own host,
   never `google`/`metered`/`cloudflare`/`twilio` etc.
4. The self-hosted TURN process answers a real STUN Binding Request on its
   UDP port (raw STUN packet sent, success response type checked).
5. Two sockets `join` the same code → both get `peer-joined`; the second
   joiner is told `initiator: true`, the first `false`.
6. A third socket joining the same code is rejected (`full`).
7. A signaling message sent by one paired device reaches the other
   verbatim, and is never echoed back to the sender.
8. When one paired device disconnects, the other receives `peer-left`.
9. Two different codes stay isolated — a message in one room never reaches
   a device in another room.

Last run: **all 9 checks passed.**

Run it:
```powershell
cd C:\projects\call_masking_test\voip-test
npm test
```

## Manual test (the real thing)

```powershell
node server.js
ngrok http 3000     # separate terminal — HTTPS needed for mic access
```
Open the ngrok URL on two devices on the same Wi-Fi, force-reload to skip
cache, allow mic, Show code on one / Enter code on the other. Confirmed
working: pairing, auto-call start, two-way audio, hang up, iOS tap-to-unlock
fallback.
