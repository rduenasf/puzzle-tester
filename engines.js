// In-browser opponents for "Play it out": Stockfish (WASM, single-threaded) and Maia-3 (ONNX).
// Both load on first use only; the service worker then keeps their files for offline use.
import { Chess } from './vendor/chess.js';

const base = new URL('./vendor/engines/', import.meta.url);

// ---------- Stockfish ----------
// Stockfish.js 18 "lite single": ~7 MB, needs no cross-origin isolation (GitHub Pages can't set it).
export class Stockfish {
  constructor() {
    this.worker = null;
    this.ready = null;
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.limited = null; // last UCI_Elo sent (null = full strength)
  }

  load() {
    if (this.ready) return this.ready;
    this.worker = new Worker(new URL('stockfish/stockfish-18-lite-single.js', base));
    this.worker.onmessage = (e) => { for (const f of [...this.listeners]) f(String(e.data)); };
    this.ready = this.until('uciok', () => this.send('uci'))
      .then(() => this.until('readyok', () => this.send('isready')));
    this.worker.onerror = (e) => { this.ready = null; for (const f of [...this.listeners]) f(`error ${e.message || 'worker failed'}`); };
    return this.ready;
  }

  send(cmd) { this.worker.postMessage(cmd); }

  // Resolve on the first line starting with `token` (after running `start`).
  until(token, start, onLine) {
    return new Promise((resolve, reject) => {
      const f = (line) => {
        if (line.startsWith('error ')) { this.listeners.delete(f); reject(new Error(line.slice(6))); return; }
        if (onLine) onLine(line);
        if (line.startsWith(token)) { this.listeners.delete(f); resolve(line); }
      };
      this.listeners.add(f);
      start();
    });
  }

  // Best move for the side to move. elo: null for full strength, else 1320–3190 (UCI_Elo).
  // Searches run one at a time; stop() ends the current one early.
  search(fen, { movetime = 1000, elo = null } = {}) {
    const run = async () => {
      await this.load();
      if (elo !== this.limited) {
        this.send(`setoption name UCI_LimitStrength value ${elo ? 'true' : 'false'}`);
        if (elo) this.send(`setoption name UCI_Elo value ${elo}`);
        this.limited = elo;
      }
      let score = null, pv = [];
      const line = await this.until('bestmove', () => {
        this.send(`position fen ${fen}`);
        this.send(`go movetime ${movetime}`);
      }, (l) => {
        if (!l.startsWith('info') || !l.includes(' pv ')) return;
        const m = l.match(/ score (cp|mate) (-?\d+)/);
        if (m) score = { [m[1]]: +m[2] };
        pv = l.split(' pv ')[1].trim().split(/\s+/);
      });
      const move = line.split(/\s+/)[1];
      return { move: move && move !== '(none)' ? move : null, score, pv };
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  stop() { if (this.worker) this.send('stop'); }
}

// ---------- Maia-3 ----------
// The Maia platform's ONNX export (CSSLab/maia-platform-frontend, GPL-3.0): one position in,
// a probability for each of 4352 moves and a loss/draw/win estimate out, at any rating.
export const MAIA_MB = 46;

function mirrorSquare(sq) { return sq[0] + (9 - +sq[1]); }
function mirrorFen(fen) {
  const [pos, turn, castle, ep, half, full] = fen.split(' ');
  const swap = (r) => r.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  const rights = castle === '-' ? '-' : (['K', 'Q', 'k', 'q'].filter((c) => castle.includes(c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('') || '-');
  return [pos.split('/').reverse().map(swap).join('/'), turn === 'w' ? 'b' : 'w', rights,
    ep === '-' ? '-' : mirrorSquare(ep), half, full].join(' ');
}
const PIECES = 'PNBRQKpnbrqk';
// (64 squares × 12 piece channels), a1 = 0, always from White's side (the board is mirrored for Black).
function tokens(fen) {
  const t = new Float32Array(64 * 12);
  fen.split(' ')[0].split('/').forEach((row, r) => {
    let file = 0;
    for (const c of row) {
      if (c >= '1' && c <= '8') { file += +c; continue; }
      t[((7 - r) * 8 + file) * 12 + PIECES.indexOf(c)] = 1;
      file++;
    }
  });
  return t;
}

export class Maia {
  constructor() {
    this.worker = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 1;
    this.moveIndex = null;
    this.onProgress = null;
  }

  load() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.moveIndex = await (await fetch(new URL('maia/all_moves_maia3.json', base))).json();
      this.worker = new Worker(new URL('./maia-worker.js', import.meta.url));
      await new Promise((resolve, reject) => {
        this.worker.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'progress') this.onProgress?.(m.loaded, m.total);
          else if (m.type === 'ready') resolve();
          else if (m.type === 'error' && m.id == null) reject(new Error(m.message));
          else if (m.type === 'result' || m.type === 'error') {
            const p = this.pending.get(m.id);
            this.pending.delete(m.id);
            if (m.type === 'error') p?.reject(new Error(m.message)); else p?.resolve(m);
          }
        };
        this.worker.onerror = (e) => reject(new Error(e.message || 'Maia worker failed'));
        this.worker.postMessage({
          type: 'init',
          ortUrl: new URL('ort/', base).href,
          modelUrl: new URL('maia/maia3_simplified.onnx', base).href,
        });
      });
    })();
    this.ready.catch(() => { this.ready = null; this.worker?.terminate(); this.worker = null; });
    return this.ready;
  }

  // Move probabilities for the side to move, as a player of rating `elo` facing `oppo`.
  // Returns { policy: [[uci, p], ...] best first, win: White's expected score 0..1 }.
  async evaluate(fen, elo, oppo = elo) {
    await this.load();
    const black = fen.split(' ')[1] === 'b';
    const view = black ? mirrorFen(fen) : fen;
    const legal = new Chess(view).moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ''));
    const id = this.nextId++;
    const t = tokens(view);
    const res = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'run', id, tokens: t, eloSelf: elo, eloOppo: oppo }, [t.buffer]);
    });
    const logits = res.logitsMove, [l, d, w] = res.logitsValue;
    const idx = legal.map((u) => this.moveIndex[u]);
    const top = Math.max(...idx.map((i) => logits[i]));
    const ex = idx.map((i) => Math.exp(logits[i] - top));
    const sum = ex.reduce((a, b) => a + b, 0);
    const unmirror = (u) => (black ? mirrorSquare(u.slice(0, 2)) + mirrorSquare(u.slice(2, 4)) + u.slice(4) : u);
    const policy = legal.map((u, k) => [unmirror(u), ex[k] / sum]).sort((a, b) => b[1] - a[1]);
    const vm = Math.max(l, d, w);
    const [el, ed, ew] = [l, d, w].map((v) => Math.exp(v - vm));
    const stm = (ew + 0.5 * ed) / (el + ed + ew); // for the side to move
    return { policy, win: black ? 1 - stm : stm };
  }
}

// A human-like pick: sample by Maia's probabilities, ignoring moves under 1%.
export function sampleMove(policy, floor = 0.01) {
  const pool = policy.filter(([, p]) => p >= floor);
  const list = pool.length ? pool : policy.slice(0, 1);
  let r = Math.random() * list.reduce((a, [, p]) => a + p, 0);
  for (const [u, p] of list) { if ((r -= p) <= 0) return [u, p]; }
  return list[list.length - 1];
}
