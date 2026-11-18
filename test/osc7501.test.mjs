import test from 'node:test';
import assert from 'node:assert/strict';
import { Osc7501Parser, PROBE_REPLY, STATUSES } from '../src/osc7501.mjs';

const ESC = '\x1b';
const seq = (body, term = `${ESC}\\`) => `${ESC}]7501;${body}${term}`;
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

/** Feed `s` one piece at a time and collect every event. */
function feedChunks(pieces) {
  const p = new Osc7501Parser();
  return pieces.flatMap(piece => p.feed(piece));
}
const cut = (s, ...at) => {
  const bounds = [0, ...at, s.length];
  return bounds.slice(1).map((end, i) => s.slice(bounds[i], end));
};

test('parses a whole report in one chunk', () => {
  const [e] = feedChunks([seq(`state=working:progress=42:app=claude:msg=${b64('building')}`)]);
  assert.deepEqual(e, {
    type: 'status', status: 'working', confidence: 'reported',
    id: null, app: 'claude', progress: 42, title: null, msg: 'building',
  });
});

test('every documented state maps to the normalized enum', () => {
  for (const [body, status] of [
    ['state=idle', 'idle'],
    ['state=working', 'working'],
    ['state=done', 'done'],
    ['state=error', 'error'],
    ['state=blocked', 'blocked'],
    ['state=blocked:kind=permission', 'blocked:permission'],
    ['state=blocked:kind=question', 'blocked:question'],
    ['state=blocked:kind=auth', 'blocked:auth'],
  ]) {
    const [e] = feedChunks([seq(body)]);
    assert.equal(e.status, status, body);
    assert.equal(e.confidence, 'reported');
    assert.ok(STATUSES.includes(e.status));
  }
});

test('clear is an action, not a status', () => {
  assert.deepEqual(feedChunks([seq('state=clear')]), [{ type: 'clear', id: null }]);
  assert.deepEqual(feedChunks([seq('state=clear:id=build/test')]), [{ type: 'clear', id: 'build/test' }]);
});

test('BEL terminates as well as ST', () => {
  const [e] = feedChunks([seq('state=done', '\x07')]);
  assert.equal(e.status, 'done');
});

test('split across two, three and many chunks', () => {
  const s = seq(`state=blocked:kind=permission:app=codex:msg=${b64('run rm -rf?')}`);
  const expected = feedChunks([s]);
  assert.equal(expected.length, 1);

  assert.deepEqual(feedChunks(cut(s, 10)), expected);
  assert.deepEqual(feedChunks(cut(s, 4, 20)), expected);
  assert.deepEqual(feedChunks([...s]), expected);                // byte at a time
  for (let i = 1; i < s.length; i++) {
    assert.deepEqual(feedChunks(cut(s, i)), expected, `split at ${i}`);
  }
});

test('split inside the 7501 digits and inside base64', () => {
  const s = seq(`state=working:msg=${b64('a longer message that will be cut')}`);
  assert.equal(feedChunks(cut(s, 4))[0].msg, 'a longer message that will be cut');   // ESC ] 7 5 | 0 1
  const mid = s.indexOf('msg=') + 10;
  assert.equal(feedChunks(cut(s, mid))[0].msg, 'a longer message that will be cut');
  assert.equal(feedChunks(cut(s, s.length - 1))[0].msg, 'a longer message that will be cut'); // ST split
});

test('ordinary output and unrelated escape sequences are ignored', () => {
  const noise = `hello\r\n${ESC}[31mred${ESC}[0m${ESC}]0;window title\x07${ESC}]133;A${ESC}\\`;
  assert.deepEqual(feedChunks([noise]), []);
  const events = feedChunks([noise, seq('state=done'), noise, seq('state=idle')]);
  assert.deepEqual(events.map(e => e.status), ['done', 'idle']);
});

test('a lone trailing ESC of an unrelated sequence does not swallow the next report', () => {
  const events = feedChunks([`out${ESC}`, `[0m${ESC}]7501;state=`, `error${ESC}\\`]);
  assert.deepEqual(events.map(e => e.status), ['error']);
});

test('truncated report does not hang the parser or corrupt the next one', () => {
  // no terminator, then a complete report
  const events = feedChunks([`${ESC}]7501;state=working`, seq('state=done')]);
  assert.deepEqual(events.map(e => e.status), ['done']);

  // a newline inside the body cancels it
  assert.deepEqual(feedChunks([`${ESC}]7501;state=working\nlogs\n`, seq('state=idle')]).map(e => e.status), ['idle']);
});

test('an oversize sequence is dropped and parsing recovers', () => {
  const p = new Osc7501Parser();
  assert.deepEqual(p.feed(`${ESC}]7501;state=working:msg=${'A'.repeat(5000)}`), []);
  assert.deepEqual(p.feed(seq('state=done')).map(e => e.status), ['done']);
});

test('malformed fields follow the spec rules', () => {
  assert.deepEqual(feedChunks([seq('app=claude')]), []);            // no state
  assert.deepEqual(feedChunks([seq('state=thinking')]), []);        // unknown state
  assert.deepEqual(feedChunks([seq('state=working:id=a//b')]), []); // invalid id
  assert.deepEqual(feedChunks([seq('')]), []);
  assert.deepEqual(feedChunks([seq(`state=working:msg=${'QQ'.repeat(2)}!!`)])[0].msg, null); // bad pair skipped

  const [e] = feedChunks([seq('nope:=x:state=blocked:kind=nonsense:progress=500:app=has space')]);
  assert.deepEqual([e.status, e.progress, e.app], ['blocked', null, null]);

  assert.deepEqual(feedChunks([seq(`state=done:msg=${b64('two\nlines')}`)]), []); // control char
  assert.deepEqual(feedChunks([seq('state=done:msg=A')]), []);                    // undecodable
});

test('progress only counts for working and blocked, last key wins', () => {
  assert.equal(feedChunks([seq('state=done:progress=50')])[0].progress, null);
  assert.equal(feedChunks([seq('state=blocked:progress=0')])[0].progress, 0);
  assert.equal(feedChunks([seq('state=idle:state=working:progress=7')])[0].progress, 7);
});

test('capability probe round trip', () => {
  const [e] = feedChunks([`${ESC}]7501;?${ESC}\\`]);
  assert.deepEqual(e, { type: 'probe', reply: PROBE_REPLY });
  assert.equal(PROBE_REPLY, `${ESC}]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth${ESC}\\`);

  // our own reply, fed back in, is recognized as a probe-shaped message, not a status
  assert.deepEqual(feedChunks([PROBE_REPLY]), [{ type: 'probe', reply: PROBE_REPLY }]);
  assert.deepEqual(feedChunks(cut(`${ESC}]7501;?${ESC}\\`, 3, 6)), [{ type: 'probe', reply: PROBE_REPLY }]);
});

test('utf8 bytes in surrounding output and in msg survive', () => {
  const s = `héllo ${seq(`state=done:msg=${b64('déjà vu ✓')}`)}`;
  const buf = Buffer.from(s, 'utf8');
  assert.equal(feedChunks([buf])[0].msg, 'déjà vu ✓');
  assert.equal(feedChunks([buf.subarray(0, 12), buf.subarray(12)])[0].msg, 'déjà vu ✓');
});

test('several reports in one chunk, and whitespace around pairs', () => {
  const events = feedChunks([seq('state=working') + 'log line' + seq(' state = blocked : kind = auth ')]);
  assert.deepEqual(events.map(e => e.status), ['working', 'blocked:auth']);
});
