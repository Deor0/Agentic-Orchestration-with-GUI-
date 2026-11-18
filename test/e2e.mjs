// End-to-end check against a running server: node test/e2e.mjs
import { WebSocket } from 'ws';

const PORT = process.env.PORT ?? 7777;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?shell=powershell`);
ws.binaryType = 'arraybuffer';

let out = '';
let ready = null;
let exited = null;

ws.on('message', (data, isBinary) => {
  if (isBinary) { out += Buffer.from(data).toString('utf8'); return; }
  const msg = JSON.parse(data.toString());
  if (msg.type === 'ready') ready = msg;
  if (msg.type === 'exit') exited = msg;
});

const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (pred, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await wait(100); }
  return false;
};

await new Promise(r => ws.on('open', r));
const send = m => ws.send(JSON.stringify(m));

const gotReady = await until(() => ready);
console.log('handshake      :', gotReady ? `PASS (${ready.shell})` : 'FAIL');

send({ type: 'resize', cols: 100, rows: 30 });
const prompt = await until(() => /PS .*>/.test(out));
console.log('shell prompt   :', prompt ? 'PASS' : 'FAIL');

send({ type: 'input', data: '[char]::ConvertFromUtf32(0x1F680)\r' });
const emoji = await until(() => out.includes('\u{1F680}'));
console.log('UTF-8 emoji    :', emoji ? 'PASS' : 'FAIL');

out = '';
send({ type: 'input', data: '$Host.UI.RawUI.WindowSize.Width\r' });
const resized = await until(() => /\b100\b/.test(out));
console.log('resize to 100  :', resized ? 'PASS' : 'FAIL');

send({ type: 'input', data: 'Start-Sleep -Seconds 30\r' });
await wait(900);
send({ type: 'interrupt' });
await wait(900);
out = '';
send({ type: 'input', data: '"ALIVE"\r' });
console.log('interrupt      :', (await until(() => out.includes('ALIVE'))) ? 'PASS' : 'FAIL');

send({ type: 'input', data: 'exit 3\r' });
const gotExit = await until(() => exited);
console.log('exit code 3    :', gotExit && exited.exitCode === 3 ? 'PASS' : `FAIL (${JSON.stringify(exited)})`);

ws.close();
process.exit(0);
