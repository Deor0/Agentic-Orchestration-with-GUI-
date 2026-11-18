import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';

const statusEl = document.getElementById('status');
const shellEl = document.getElementById('shell');
const setStatus = t => { statusEl.textContent = t; };

const term = new Terminal({
  convertEol: false,
  cursorBlink: true,
  fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
  fontSize: 13,
  theme: { background: '#0b0d10', foreground: '#c9d1d9' },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));
fit.fit();

// Bytes in, bytes out: the server owns UTF-8 decoding boundaries, so feed
// xterm the raw Uint8Array and let its own decoder handle split code points.
let socket;

function connect(shellId) {
  socket?.close();
  term.reset();
  setStatus('connecting…');

  const qs = new URLSearchParams();
  if (shellId) qs.set('shell', shellId);
  socket = new WebSocket(`ws://${location.host}/?${qs}`);
  socket.binaryType = 'arraybuffer';

  socket.onmessage = ev => {
    if (ev.data instanceof ArrayBuffer) return term.write(new Uint8Array(ev.data));
    const msg = JSON.parse(ev.data);
    if (msg.type === 'ready') setStatus(`${msg.shell} · ${msg.cwd}`);
    else if (msg.type === 'exit') setStatus(`exited (code ${msg.exitCode})`);
    else if (msg.type === 'error') setStatus(`error: ${msg.message}`);
  };
  socket.onopen = () => sendResize();
  socket.onclose = () => setStatus('disconnected');
}

const send = msg => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(msg));

term.onData(data => send({ type: 'input', data }));

function sendResize() {
  fit.fit();
  send({ type: 'resize', cols: term.cols, rows: term.rows });
}

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(sendResize, 80);
});

document.getElementById('interrupt').onclick = () => { send({ type: 'interrupt' }); term.focus(); };

const { shells, default: def } = await (await fetch('/api/shells')).json();
shellEl.innerHTML = shells.map(s => `<option value="${s.id}">${s.label}</option>`).join('');
shellEl.value = def;
shellEl.onchange = () => connect(shellEl.value);

connect(def);
