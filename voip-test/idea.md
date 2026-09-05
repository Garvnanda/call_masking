# Idea

Bare-bones 2-device voice call test. No accounts, no app store, no product —
just prove real-time browser-to-browser voice works between two physical
devices, with everything self-hosted (no third-party call/relay service, no
paid infra).

## Original ask

A web page with one "Call" button. Open it on two devices. Click Call.
Two-way voice flows directly between them.

## How the pieces fit

1. **Signaling server** (Node, Express + `ws`) — a small server both devices
   connect to first. It never touches audio, just relays a handful of JSON
   messages (the WebRTC handshake) between the two devices.
2. **STUN/TURN** — tells each device its own reachable address, and relays
   media when a direct path isn't possible (NAT/firewall in the way).
   Self-hosted (`node-turn`, pure JS) instead of a public/third-party STUN —
   nothing external is used.
3. **WebRTC** (built into the browser) — once both sides know how to reach
   each other, it opens a direct, encrypted audio connection. The signaling
   server is not involved in call audio.

## Requirement that shaped everything: no third party, no cost

The ask evolved from "get it working" to "get it working with nothing
rented and nothing paid for" — no public STUN/TURN service, no cloud
hosting, no ngrok-as-a-permanent-dependency. That constraint is why:

- STUN/TURN ended up self-hosted (`node-turn` inside `server.js`) instead of
  Google's public STUN or a metered.ca/OpenRelay TURN.
- Pairing is code-based (`Show code` / `Enter code`) rather than
  "whoever else is connected" — closer to how a real call app works, and
  sets up the room concept a self-hosted deploy would need anyway.
- ngrok is used only for local dev convenience (HTTPS for mic access) — not
  a hard dependency of the design.

## The wall this hit

Two devices on **different networks** (e.g. one on Wi-Fi, one on mobile
data) can only find each other directly if at least one side has a real,
reachable public IP. Most home internet and effectively all mobile carrier
connections sit behind NAT (mobile carriers use CGNAT specifically), which
blocks that. There is no software fix for this — it's how IPv4 routing
works. Every commercial voice app (WhatsApp, Zoom, FaceTime, Discord) solves
it by running relay servers on infrastructure they pay for.

Given the "no cost, no third party" constraint, the ceiling for this project
is:
- **Same network** (same Wi-Fi, or same LAN) — fully working, verified.
- **Cross-network** — works only if the hosting machine has a real public
  IPv4 (no CGNAT) and its router is port-forwarded to it, or if both
  devices happen to have public IPv6. Neither is guaranteed and neither
  needed new code — see `done.md` for the exact steps to check and enable
  each, if you want to chase it further.

This is a real networking limit, not a gap in the build.
