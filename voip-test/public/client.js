// Filled from our own server's /config at startup — self-hosted STUN/TURN only.
let configuration = { iceServers: [], iceCandidatePoolSize: 4 };

async function loadConfig() {
  const res = await fetch('/config', { cache: 'no-store' });
  configuration = await res.json();
  console.log('[config]', JSON.stringify(configuration.iceServers));
}

const showCodeBtn = document.getElementById('showCodeBtn');
const enterCodeBtn = document.getElementById('enterCodeBtn');
const showCodeBox = document.getElementById('showCodeBox');
const enterCodeBox = document.getElementById('enterCodeBox');
const codeDisplay = document.getElementById('codeDisplay');
const codeInput = document.getElementById('codeInput');
const joinBtn = document.getElementById('joinBtn');
const lobby = document.getElementById('lobby');
const hangupBtn = document.getElementById('hangupBtn');
const statusEl = document.getElementById('status');
const remoteAudio = document.getElementById('remoteAudio');

let ws;
let pc;
let localStream;

function setStatus(msg) {
  statusEl.textContent = msg;
  console.log('[status]', msg);
}

function genCode() {
  // ponytail: 6-digit random, tiny collision chance — fine for a 2-device test.
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function init() {
  try {
    await loadConfig();
  } catch (err) {
    setStatus('Could not load /config from server: ' + err.message);
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    setStatus('Mic ready.');
  } catch (err) {
    setStatus('Mic access denied or unavailable: ' + err.message);
    return;
  }
  connectSignaling();
}

function connectSignaling() {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProtocol}//${location.host}`);

  ws.onopen = () => {
    setStatus('Connected. Show a code or enter one.');
    showCodeBtn.disabled = false;
    enterCodeBtn.disabled = false;
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'peer-joined') {
      lobby.hidden = true;
      hangupBtn.hidden = false;
      if (data.initiator) {
        setStatus('Paired. Starting call...');
        startCall();
      } else {
        setStatus('Paired. Waiting for call to start...');
      }
    } else if (data.type === 'full') {
      setStatus('That code is already in use by two devices. Try another.');
    } else if (data.type === 'offer') {
      await handleOffer(data);
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
    } else if (data.type === 'candidate' && pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('Error adding ICE candidate', err);
      }
    } else if (data.type === 'bye' || data.type === 'peer-left') {
      endCall(data.type === 'bye' ? 'Call ended by other side' : 'Other device left');
    }
  };

  ws.onclose = () => {
    setStatus('Disconnected from server');
    showCodeBtn.disabled = true;
    enterCodeBtn.disabled = true;
  };
}

showCodeBtn.onclick = () => {
  const code = genCode();
  codeDisplay.textContent = code;
  showCodeBox.hidden = false;
  enterCodeBox.hidden = true;
  showCodeBtn.disabled = true;
  enterCodeBtn.disabled = true;
  ws.send(JSON.stringify({ type: 'join', code }));
  setStatus('Waiting for the other device to enter this code...');
};

enterCodeBtn.onclick = () => {
  enterCodeBox.hidden = false;
  showCodeBox.hidden = true;
  showCodeBtn.disabled = true;
  enterCodeBtn.disabled = true;
  codeInput.focus();
};

joinBtn.onclick = () => {
  const code = codeInput.value.trim();
  if (!code) return;
  ws.send(JSON.stringify({ type: 'join', code }));
  setStatus('Joining ' + code + '...');
};

function createPeerConnection() {
  pc = new RTCPeerConnection(configuration);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
    }
  };

  pc.ontrack = (event) => {
    remoteAudio.srcObject = event.streams[0];
    // iOS Safari blocks autoplay; play() may reject until a user gesture.
    remoteAudio.play().catch(() => {
      setStatus('Connected — tap anywhere to enable audio');
      document.body.addEventListener(
        'click',
        () => { remoteAudio.play(); setStatus('In call'); },
        { once: true }
      );
    });
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[ice]', pc.iceConnectionState);
    if (pc.iceConnectionState === 'checking') setStatus('Connecting media...');
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      setStatus('In call');
      logSelectedPair();
    }
    if (pc.iceConnectionState === 'failed') {
      setStatus('Media failed (NAT/TURN). Restarting ICE...');
      pc.restartIce();
    }
    if (pc.iceConnectionState === 'disconnected') {
      setStatus('Media dropped, trying to recover...');
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[conn]', pc.connectionState);
  };

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
}

async function logSelectedPair() {
  try {
    const stats = await pc.getStats();
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
        const local = stats.get(r.localCandidateId);
        const remote = stats.get(r.remoteCandidateId);
        const line = `path: ${local && local.candidateType} <-> ${remote && remote.candidateType}`;
        console.log('[selected]', line);
        setStatus('In call (' + line + ')');
      }
    });
  } catch (e) {
    console.warn('getStats failed', e);
  }
}

async function startCall() {
  createPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify(pc.localDescription));
}

async function handleOffer(offer) {
  createPeerConnection();
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify(pc.localDescription));
}

function endCall(msg) {
  if (pc) {
    pc.close();
    pc = null;
  }
  setStatus(msg);
  hangupBtn.hidden = true;
  lobby.hidden = false;
  showCodeBox.hidden = true;
  enterCodeBox.hidden = true;
  codeInput.value = '';
  showCodeBtn.disabled = false;
  enterCodeBtn.disabled = false;
}

hangupBtn.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'bye' }));
  }
  endCall('Call ended');
};

init();
