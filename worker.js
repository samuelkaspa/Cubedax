// CUBEDAX - servidor multiplayer (Cloudflare Worker + Durable Object)
// O próprio Worker serve o jogo (index.html) e o WebSocket em /ws.
import { DurableObject } from "cloudflare:workers";
import page from "./index.html";

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
// mensagens do jogador que o servidor apenas repassa aos outros
const RELAY = new Set(["st", "door", "kn", "ek", "dead", "win", "pick", "hit", "met", "stomp", "bo", "stun"]);
const MODES = new Set(["easy", "normal", "hard"]);
const KINDS = new Set(["coop", "race", "battle"]);
const isRace = (k) => k === "race" || k === "battle";

const clean = (s, n) =>
  String(s == null ? "" : s).replace(/[<>&"'`\\]/g, "").trim().slice(0, n);
const rnd = (n) => Math.floor(Math.random() * n);

class Hub {
  constructor() {
    this.rooms = new Map();
    this.clients = new Set();
  }

  // ---------- utilidades ----------
  add(ws) {
    const c = { ws, room: null, s: -1, sub: false, name: "Cubedax", rec: "—", recs: { easy: "—", normal: "—", hard: "—" }, skin: "preto", ready: false };
    this.clients.add(c);
    return c;
  }
  send(c, o) {
    try { c.ws.send(JSON.stringify(o)); } catch (e) {}
  }
  cast(r, o, except) {
    for (const c of r.pl) if (c && c !== except) this.send(c, o);
  }
  count(r) {
    return r.pl.filter(Boolean).length;
  }
  list() {
    return [...this.rooms.values()]
      .filter((r) => !r.priv && !r.started)
      .map((r) => ({ code: r.code, host: r.pl[r.host].name, n: this.count(r), max: r.max }));
  }
  push() {
    const l = { t: "rooms", list: this.list() };
    for (const c of this.clients) if (c.sub) this.send(c, l);
  }
  view(r) {
    const players = [];
    r.pl.forEach((c, s) => {
      if (c) players.push({ s, name: c.name, rec: c.rec, recs: c.recs, skin: c.skin, ready: c.ready });
    });
    return {
      code: r.code, priv: r.priv, mode: r.mode, kind: r.kind, rt: r.rt, rp: r.rp,
      max: r.max, host: r.host, started: r.started, players,
    };
  }
  sync(r) {
    r.pl.forEach((c) => {
      if (c) this.send(c, { t: "room", you: c.s, room: this.view(r) });
    });
  }

  // ---------- mapas ----------
  // 15 tipos de mapa: cada ciclo de 15 usa todos os tipos, em ordem embaralhada
  plan() {
    const out = [];
    let last = -1;
    while (out.length < 30) {
      const a = [...Array(15).keys()];
      for (let i = 14; i > 0; i--) {
        const j = rnd(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      if (a[0] === last) [a[0], a[1]] = [a[1], a[0]];
      last = a[14];
      for (const t of a) out.push({ t, s: rnd(1e6) });
    }
    return out.slice(0, 30);
  }
  one(r) {
    let t;
    do { t = rnd(15); } while (t === r.lt);
    r.lt = t;
    return { t, s: rnd(1e6) };
  }

  // ---------- cooperativo: recomeçar quando todos pedem ----------
  chk(r) {
    const n = this.count(r);
    if (r.started && r.retry.size && r.retry.size >= n) {
      r.retry.clear();
      this.cast(r, { t: "restart", plan: this.plan(), mode: r.mode });
    } else if (r.started && r.retry.size) {
      this.cast(r, { t: "retry", n: r.retry.size, of: n });
    }
  }

  // ---------- corrida / batalha ----------
  arm(r) {
    const alive = new Set();
    r.pl.forEach((c, s) => { if (c) alive.add(s); });
    r.rd = { over: false, mo: false, alive };
    r.rdy = new Set();
    clearTimeout(r.rto);
    clearTimeout(r.bto);
    r.bto = 0;
  }
  // batalha: quando sobra 1 (ou 0), espera 0,7s e fecha a rodada
  bchk(r) {
    const d = r.rd;
    if (!d || d.over || r.bto || d.alive.size > 1) return;
    r.bto = setTimeout(() => {
      r.bto = 0;
      if (r.rd !== d || d.over) return;
      const a = [...d.alive];
      this.rend(r, a.length === 1 ? a[0] : -1);
    }, 700);
  }
  rend(r, winner) {
    const d = r.rd;
    if (!d || d.over) return;
    d.over = true;
    if (winner >= 0) r.score[winner]++;
    const over = winner >= 0 && r.score[winner] >= r.rp;
    d.mo = over;
    this.cast(r, { t: "rend", w: winner, score: r.score.slice(), over, mw: over ? winner : -1 });
    r.rto = setTimeout(() => (over ? this.rematch(r) : this.rnext(r)), over ? 10000 : 20000);
  }
  startRace(r) {
    r.score = [0, 0, 0, 0];
    r.round = 0;
    r.lt = -1;
    this.arm(r);
    this.cast(r, {
      t: "start", kind: r.kind, plan: [this.one(r)], mode: r.mode,
      rp: r.rp, rt: r.rt, score: r.score.slice(),
    });
  }
  rematch(r) {
    clearTimeout(r.rto);
    if (this.rooms.get(r.code) !== r || !r.started || !isRace(r.kind) || this.count(r) < 2) return;
    this.startRace(r);
  }
  rnext(r) {
    clearTimeout(r.rto);
    if (this.rooms.get(r.code) !== r || !r.started || !isRace(r.kind) || !r.rd || !r.rd.over || r.rd.mo) return;
    r.round++;
    this.arm(r);
    this.cast(r, { t: "rnext", n: r.round, sp: this.one(r), score: r.score.slice() });
  }

  // ---------- entrar / sair ----------
  leave(c) {
    const r = c.room;
    if (!r) return;
    const s = c.s;
    r.pl[s] = null;
    r.retry.delete(s);
    c.room = null;
    c.s = -1;
    c.ready = false;

    if (!this.count(r)) {
      clearTimeout(r.rto);
      clearTimeout(r.bto);
      this.rooms.delete(r.code);
    } else {
      if (r.host === s) r.host = r.pl.findIndex(Boolean);
      if (r.started && isRace(r.kind)) {
        if (this.count(r) < 2) {
          r.started = false;
          clearTimeout(r.rto);
          clearTimeout(r.bto);
          r.bto = 0;
          r.pl.forEach((x) => { if (x) x.ready = false; });
        } else if (r.rd) {
          r.rd.alive.delete(s);
          if (!r.rd.over) {
            if (r.kind === "battle") this.bchk(r);
            else if (!r.rd.alive.size) this.rend(r, -1);
          } else if (!r.rd.mo && r.rdy.size >= this.count(r)) {
            this.rnext(r);
          }
        }
      }
      this.sync(r);
      this.chk(r);
    }
    this.push();
  }
  drop(c) {
    this.clients.delete(c);
    this.leave(c);
  }

  // ---------- mensagens do cliente ----------
  msg(c, raw) {
    if (typeof raw !== "string" || raw.length > 600) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;
    const r = c.room;

    switch (m.t) {
      case "ping":
        break;

      case "sub":
        c.sub = !!m.v;
        if (c.sub) this.send(c, { t: "rooms", list: this.list() });
        break;

      case "prof":
        c.name = clean(m.name, 12) || "Cubedax";
        c.rec = clean(m.rec, 12) || "—";
        for (const k of MODES) c.recs[k] = clean(m.recs && m.recs[k], 12) || "—";
        c.skin = clean(m.skin, 10) || "preto";
        if (r) { this.sync(r); this.push(); }
        break;

      case "create": {
        if (r) return;
        let code;
        do {
          code = Array.from({ length: 4 }, () => CODE_CHARS[rnd(CODE_CHARS.length)]).join("");
        } while (this.rooms.has(code));
        const room = {
          code,
          priv: !!m.priv,
          mode: "normal",
          max: Math.max(2, Math.min(4, +m.max || 4)),
          host: 0,
          started: false,
          pl: [c],
          retry: new Set(),
          kind: KINDS.has(m.kind) ? m.kind : "coop",
          rt: m.kind === "battle" ? 60 : 20,
          rp: 3,
          score: [0, 0, 0, 0],
          round: 0,
          rd: null,
          rdy: new Set(),
          rto: 0,
          bto: 0,
          lt: -1,
        };
        this.rooms.set(code, room);
        c.room = room;
        c.s = 0;
        c.ready = false;
        this.sync(room);
        this.push();
        break;
      }

      case "join": {
        if (r) return;
        const room = this.rooms.get(clean(m.code, 4).toUpperCase());
        if (!room) return this.send(c, { t: "err", m: "Sala não encontrada." });
        if (room.started) return this.send(c, { t: "err", m: "A partida já começou." });
        let s = -1;
        for (let i = 0; i < room.max; i++) {
          if (!room.pl[i]) { s = i; break; }
        }
        if (s < 0) return this.send(c, { t: "err", m: "Sala cheia." });
        room.pl[s] = c;
        c.room = room;
        c.s = s;
        c.ready = false;
        this.sync(room);
        this.push();
        break;
      }

      case "mode":
        if (r && !r.started && r.host === c.s && MODES.has(m.v)) {
          r.mode = m.v;
          this.sync(r);
        }
        break;

      case "rcfg":
        if (r && !r.started && r.host === c.s) {
          r.rt = Math.max(5, Math.min(120, Math.round(+m.tm || r.rt)));
          r.rp = Math.max(1, Math.min(20, Math.round(+m.p || r.rp)));
          this.sync(r);
        }
        break;

      case "rready":
        if (r && r.started && isRace(r.kind) && r.rd && r.rd.over && !r.rd.mo) {
          r.rdy.add(c.s);
          if (r.rdy.size >= this.count(r)) this.rnext(r);
        }
        break;

      case "leave":
        this.leave(c);
        break;

      case "ready":
        if (r && !r.started) {
          c.ready = !!m.v;
          this.sync(r);
        }
        break;

      case "start":
        if (r && !r.started && r.host === c.s) {
          if (this.count(r) < 2 || r.pl.some((x) => x && x !== c && !x.ready)) {
            return this.send(c, { t: "err", m: "Todos precisam estar prontos." });
          }
          r.started = true;
          r.retry.clear();
          this.sync(r);
          if (isRace(r.kind)) this.startRace(r);
          else this.cast(r, { t: "start", plan: this.plan(), mode: r.mode });
          this.push();
        }
        break;

      case "retry":
        if (r && r.started) {
          r.retry.add(c.s);
          this.chk(r);
        }
        break;

      case "back":
        if (r && r.started) {
          r.started = false;
          r.retry.clear();
          clearTimeout(r.rto);
          r.pl.forEach((x) => { if (x) x.ready = false; });
          this.sync(r);
          this.push();
        }
        break;

      case "cardres":
        if (r && r.started && r.host === c.s) {
          m.s = c.s;
          this.cast(r, m, c);
        }
        break;

      default:
        if (r && r.started && RELAY.has(m.t)) {
          if (isRace(r.kind)) {
            const d = r.rd;
            if (!d || d.over) return;
            m.s = c.s;
            this.cast(r, m, c);
            if (m.t === "win" && r.kind === "race") {
              this.rend(r, c.s);
            } else if (m.t === "dead") {
              d.alive.delete(c.s);
              if (r.kind === "battle") this.bchk(r);
              else if (!d.alive.size) this.rend(r, -1);
            }
            return;
          }
          m.s = c.s;
          this.cast(r, m, c);
        }
    }
  }
}

// ---------- Durable Object: guarda todas as salas ----------
export class GameHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.hub = new Hub();
  }

  async fetch(req) {
    if ((req.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return new Response("Use WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const c = this.hub.add(server);
    server.addEventListener("message", (e) => {
      try { this.hub.msg(c, e.data); } catch (x) { console.log("msg error", x && x.stack); }
    });
    const gone = () => {
      try { this.hub.drop(c); } catch (x) { console.log("drop error", x && x.stack); }
    };
    server.addEventListener("close", gone);
    server.addEventListener("error", gone);

    return new Response(null, { status: 101, webSocket: client });
  }
}

// ---------- Worker: /ws = multiplayer, o resto = o jogo ----------
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/ws") {
      return env.HUB.get(env.HUB.idFromName("global")).fetch(req);
    }
    return new Response(page, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  },
};
