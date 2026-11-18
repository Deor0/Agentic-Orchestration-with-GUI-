// OSC 7501 Program Status Protocol, rev 0.4 (2026-10-10).
// Spec: https://www.superlogical.com/rex/docs/build/program-status
// Pure: bytes in, events out. No I/O, no PTY, no timers.

const ESC = '\x1b';
const BEL = '\x07';
const PREFIX = `${ESC}]7501;`;

const MAX_SEQ = 4096;                    // whole sequence, introducer through terminator
const MAX = { key: 16, app: 32, id: 128, msg: 2732, title: 256 };
const MAX_DECODED = { msg: 2048, title: 192 };

const STATES = new Set(['idle', 'working', 'done', 'blocked', 'error', 'clear']);
const KINDS = new Set(['permission', 'question', 'auth']);
const SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;

/** Normalized statuses this module can emit. `blocked` bare = program said
 *  blocked without a kind. The spec has no `plan` kind; that one can only come
 *  from a lower-confidence scraping tier. */
export const STATUSES = [
  'working', 'blocked:permission', 'blocked:question', 'blocked:auth',
  'blocked', 'done', 'error', 'idle',
];

/** Reply to the capability probe. Lists everything rev 0.4 defines, so a
 *  program never has to assume the defaults. */
export const PROBE_REPLY =
  `${PREFIX}?:states=idle,working,done,blocked,error:kinds=permission,question,auth${ESC}\\`;

export class Osc7501Parser {
  #pending = '';

  /** @param {Buffer|Uint8Array|string} chunk @returns {object[]} events */
  feed(chunk) {
    const s = this.#pending + (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('latin1'));
    this.#pending = '';
    const events = [];

    for (let i = 0; i < s.length;) {
      const start = s.indexOf(ESC, i);
      if (start < 0) break;                      // plain output: nothing worth keeping
      const head = s.slice(start, start + PREFIX.length);

      // Chunk ended inside a possible introducer (e.g. split mid-"7501"); keep
      // it and decide once the rest arrives. At most PREFIX.length bytes held.
      if (head.length < PREFIX.length) {
        if (PREFIX.startsWith(head)) this.#pending = head;
        else i = start + 1;
        if (this.#pending) break;
        continue;
      }
      if (head !== PREFIX) { i = start + 1; continue; }   // some other escape sequence

      const body = start + PREFIX.length;
      const end = findEnd(s, body);
      if (!end) {
        if (s.length - start > MAX_SEQ) { i = body; continue; }  // over the limit: discard
        this.#pending = s.slice(start);
        break;
      }
      if (end.ok && end.at - start <= MAX_SEQ) {
        const event = parseBody(s.slice(body, end.at));
        if (event) events.push(event);
      }
      i = end.next;
    }
    return events;
  }
}

/** Locate the terminator. An ESC that is not ST, or any other C0/DEL byte,
 *  cancels the report — otherwise a truncated report would swallow the next one. */
function findEnd(s, from) {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === BEL) return { ok: true, at: i, next: i + 1 };
    if (c === ESC) {
      if (i + 1 >= s.length) return null;        // need one more byte to tell ST apart
      if (s[i + 1] === '\\') return { ok: true, at: i, next: i + 2 };
      return { ok: false, at: i, next: i };      // rescan this ESC as a fresh introducer
    }
    if (c < ' ' || c === '\x7f') return { ok: false, at: i, next: i + 1 };
  }
  return null;
}

const BAD = Symbol('bad');

function parseBody(body) {
  const parts = body.split(':');
  if (parts[0].trim() === '?') return { type: 'probe', reply: PROBE_REPLY };

  const f = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;                        // no '=' or empty key: skip this pair only
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key.length > MAX.key || !/^[a-z]+$/.test(key)) continue;
    if (!/^[A-Za-z0-9_.,+/=-]*$/.test(value)) continue;
    f[key] = value;                              // repeated key: last wins
  }

  const state = f.state;
  if (!STATES.has(state)) return null;
  if (f.id !== undefined && !validId(f.id)) return null;
  if (state === 'clear') return { type: 'clear', id: f.id ?? null };

  const msg = decodeText(f.msg, MAX.msg, MAX_DECODED.msg);
  const title = decodeText(f.title, MAX.title, MAX_DECODED.title);
  if (msg === BAD || title === BAD) return null;

  const kind = KINDS.has(f.kind) ? f.kind : null;
  const indeterminate = !(state === 'working' || state === 'blocked');
  const progress = indeterminate || !/^\d{1,3}$/.test(f.progress ?? '') || +f.progress > 100
    ? null : +f.progress;

  return {
    type: 'status',
    status: state === 'blocked' ? (kind ? `blocked:${kind}` : 'blocked') : state,
    confidence: 'reported',
    id: f.id ?? null,
    app: SEGMENT.test(f.app ?? '') ? f.app : null,
    progress, title, msg,
  };
}

function validId(id) {
  const segments = id.split('/');
  return id.length <= MAX.id && segments.length <= 8 && segments.every(s => SEGMENT.test(s));
}

/** Standard base64 of UTF-8, padding optional. Returns BAD for anything the
 *  spec says must sink the whole report: oversize, undecodable, or control
 *  characters (which would otherwise let a program forge terminal output). */
function decodeText(value, maxEncoded, maxDecoded) {
  if (value === undefined) return null;
  if (value.length > maxEncoded) return BAD;
  const b64 = value.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(b64) || b64.length % 4 === 1) return BAD;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > maxDecoded) return BAD;
  const text = buf.toString('utf8');
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return BAD;
  return text;
}
