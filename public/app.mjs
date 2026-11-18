import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';

const $ = id => document.getElementById(id);
const boardEl = $('board'), titleEl = $('title'), statusEl = $('status');
const termEl = $('term'), emptyEl = $('empty'), shellEl = $('shell');

const BUCKET_LABEL = {
  needsYou: 'needs you', failed: 'failed', working: 'working', done: 'done', idle: 'idle',
};

let current = null;      // pane id being viewed
let paneSocket = null;
let latest = { buckets: {}, order: [] };

// ---------- terminal ----------

const term = new Terminal({
  cursorBlink: true, fontSize: 13,
  fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
  theme: { background: '#0b0d10', foreground: '#c9d1d9' },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(termEl);

const send = msg => paneSocket?.readyState === WebSocket.OPEN && paneSocket.send(JSON.stringify(msg));
term.onData(data => send({ type: 'input', data }));

function sendResize() {
  if (!current) return;
  fit.fit();
  send({ type: 'resize', cols: term.cols, rows: term.rows });
}
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(sendResize, 80); });

function open(id) {
  if (id === current) return;
  current = id;
  paneSocket?.close();
  term.reset();
  termEl.style.display = '';
  emptyEl.style.display = 'none';

  paneSocket = new WebSocket(`ws://${location.host}/?pane=${encodeURIComponent(id)}`);
  paneSocket.binaryType = 'arraybuffer';
  paneSocket.onmessage = ev => {
    if (ev.data instanceof ArrayBuffer) return term.write(new Uint8Array(ev.data));
    const msg = JSON.parse(ev.data);
    if (msg.type === 'ready') { titleEl.textContent = msg.title; statusEl.textContent = ''; sendResize(); }
    else if (msg.type === 'exit') statusEl.textContent = `exited ${msg.exitCode}`;
    else if (msg.type === 'error') statusEl.textContent = msg.message;
  };
  paneSocket.onopen = () => { sendResize(); term.focus(); };
  render();
}

function showEmpty() {
  current = null;
  paneSocket?.close();
  paneSocket = null;
  termEl.style.display = 'none';
  emptyEl.style.display = '';
  titleEl.textContent = 'no agent selected';
  statusEl.textContent = '';
}

// ---------- board ----------

const ago = ms => ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;

function render() {
  boardEl.textContent = '';
  if (!latest.order.length) {
    boardEl.innerHTML = '<p style="color:#7d8590;padding:10px">no agents yet</p>';
    return;
  }

  for (const [bucket, rows] of Object.entries(latest.buckets)) {
    if (!rows?.length) continue;
    const section = document.createElement('section');
    section.className = `bucket ${bucket}`;
    section.innerHTML = `<h2>${BUCKET_LABEL[bucket]} <span>${rows.length}</span></h2>`;

    for (const row of rows) {
      const el = document.createElement('div');
      // `stale` is carried separately from `confidence`: a reported-working pane
      // that has gone quiet is still "reported", so both fields must be read.
      el.className = `row ${bucket} ${row.confidence === 'inferred' || row.stale ? 'inferred' : ''}`
        + (row.id === current ? ' active' : '');
      el.onclick = () => open(row.id);

      const meta = row.waitingMs != null ? ago(row.waitingMs)
        : row.exitCode != null ? `exit ${row.exitCode}`
        : row.stale ? 'quiet' : '';

      el.innerHTML = `<span class="dot"></span>
        <span class="name"></span>
        <span class="meta">${meta}</span>
        <span class="close" title="close agent">×</span>`;
      el.querySelector('.name').textContent = row.title;
      el.querySelector('.close').onclick = e => { e.stopPropagation(); closePane(row.id); };
      section.append(el);
    }
    boardEl.append(section);
  }
}

// ---------- actions ----------

async function newPane() {
  const res = await fetch('/api/panes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ shellId: shellEl.value }),
  });
  if (res.ok) open((await res.json()).id);
}

async function closePane(id) {
  await fetch(`/api/panes/${id}`, { method: 'DELETE' });
  if (id === current) showEmpty();
}

$('new').onclick = newPane;
$('interrupt').onclick = () => { send({ type: 'interrupt' }); term.focus(); };

// The single most useful key here: go to whoever has waited longest.
addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'j') {
    e.preventDefault();
    const target = latest.buckets.needsYou?.[0] ?? latest.order[0];
    if (target) open(target.id);
  }
});

// ---------- fleet socket ----------

function connectFleet() {
  const ws = new WebSocket(`ws://${location.host}/?fleet=1`);
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'focus') return open(msg.id);   // user clicked a toast
    if (msg.type !== 'inbox') return;
    latest = msg;
    // A pane that disappeared server-side must not leave a dead terminal up.
    if (current && !latest.order.some(r => r.id === current)) showEmpty();
    render();
  };
  ws.onclose = () => setTimeout(connectFleet, 1000);
}

const { shells, default: def } = await (await fetch('/api/shells')).json();
shellEl.innerHTML = shells.map(s => `<option value="${s.id}">${s.label}</option>`).join('');
shellEl.value = def;

showEmpty();
connectFleet();
