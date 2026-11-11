// sync.js: progress sync between your devices (shared across the games; same file in each).
//
// No accounts server and no email: turning sync on makes a random sync code. Enter the code (or open
// the link / scan the QR) on another device and both share the same progress. Every game on
// merchantsteam29.github.io shares browser storage, so one code covers all of them on that device.
//
// Saves go through the same free public relays as Trigger Happy (MQTT, retained messages), encrypted
// with a key made from the code, so the relays (and anyone else) only see scrambled bytes. Only the
// keys a game lists are synced (progress and best scores, never settings like graphics or volume).
//
//   <script src="sync.js"></script>
//   GameSync.init({ game: 'wardnine', keys: [{ match: /^ward9-best/, mode: 'max' }], idle: () => state === 'menu' });
//   GameSync.open()               // the Sync panel (put a button in the menu that calls this)
//
// Each key's rule: mode 'lww' (default: the newest change wins) or 'max' (numbers keep the higher,
// true wins over false, lists and objects are merged that way field by field). `skip` lists fields of a
// JSON object that stay per-device. When another device's progress arrives, the page reloads if the
// game says it's `idle` (at the title), otherwise a small note offers to reload.
(function () {
  'use strict';
  if (window.GameSync) return;
  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
  const LIB = 'https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js';
  const TOPIC = 'mmgames/v1/sync/';
  const ACC = 'gamesync.account', META = 'gamesync.meta.', SEEN = 'gamesync.seen.';
  const MAX_VALUE = 120000; // bytes: bigger saves (replays) are left out
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* full or blocked */ } },
    keys() { try { return Object.keys(localStorage); } catch { return []; } },
  };
  const jget = (k, d) => { try { const v = ls.get(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const jset = (k, v) => ls.set(k, JSON.stringify(v));

  // ---------- the code, and the key and topic made from it ----------
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
  const newCode = () => { const b = crypto.getRandomValues(new Uint8Array(20)); return [...b].map((x) => ALPHA[x & 31]).join('').replace(/(.{4})(?=.)/g, '$1-'); };
  const clean = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/[01OI]/g, (ch) => ({ 0: 'O', 1: 'I' })[ch] || ch);
  const fmt = (c) => clean(c).replace(/(.{4})(?=.)/g, '$1-');
  const valid = (c) => clean(c).length === 20 && [...clean(c)].every((ch) => ALPHA.includes(ch));
  const te = new TextEncoder(), td = new TextDecoder();
  const sha = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s)));
  const hex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
  let keyP = null, idP = null;
  function deriveFrom(code) {
    const c = clean(code);
    idP = sha('id:' + c).then((h) => hex(h).slice(0, 32));
    keyP = sha('key:' + c).then((h) => crypto.subtle.importKey('raw', h, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  async function seal(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyP, te.encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
  }
  async function open(bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, await keyP, u.slice(12));
    return JSON.parse(td.decode(pt));
  }

  // ---------- merging ----------
  function deepMax(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return Math.max(a, b);
    if (typeof a === 'boolean' && typeof b === 'boolean') return a || b;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.every((x) => typeof x !== 'object') && b.every((x) => typeof x !== 'object')) return [...new Set([...a, ...b])];
      return b.length > a.length ? b : a;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const o = { ...a };
      for (const k of Object.keys(b)) o[k] = k in a ? deepMax(a[k], b[k]) : b[k];
      return o;
    }
    return a === undefined ? b : a;
  }
  const parse = (s) => { try { return JSON.parse(s); } catch { return s; } };

  // ---------- state ----------
  let cfg = null, acc = jget(ACC, null), meta = {}, last = {}, relay = [], status = 'off', lastSync = 0, pending = false, pushT = 0, gotRemote = false, onChange = [];
  const ruleFor = (k) => cfg && (k === 'gamesach.' + cfg.game ? { mode: 'max' } : cfg.keys.find((r) => (r.match instanceof RegExp ? r.match.test(k) : k === r.match || (typeof r.match === 'string' && r.match.endsWith('*') && k.startsWith(r.match.slice(0, -1))))));
  const syncedKeys = () => ls.keys().filter((k) => ruleFor(k) && !k.startsWith('gamesync.'));
  const setStatus = (s) => { status = s; for (const f of onChange) f(); };

  // what this device has, with a time for each key (a key's time moves when its value changes here)
  function snapshot(fresh) {
    const keys = {};
    for (const k of syncedKeys()) {
      const v = ls.get(k); if (v == null || v.length > MAX_VALUE) continue;
      if (last[k] !== v) { if (!fresh && last[k] !== undefined) meta[k] = Date.now(); else if (meta[k] === undefined) meta[k] = fresh === 'join' ? 0 : Date.now(); last[k] = v; }
      keys[k] = { v, t: meta[k] || 0 };
    }
    jset(META + cfg.game, meta);
    return keys;
  }

  async function publish() {
    if (!acc || !relay.length) return;
    const keys = snapshot();
    const body = await seal({ v: 1, game: cfg.game, keys });
    const topic = TOPIC + (await idP) + '/' + cfg.game;
    for (const c of relay) if (c.connected) c.publish(topic, body, { qos: 1, retain: true });
    lastSync = Date.now(); setStatus('on');
  }
  function schedulePush(ms = 1500) { clearTimeout(pushT); pushT = setTimeout(() => publish().catch(() => {}), ms); }

  async function receive(bytes) {
    let doc; try { doc = await open(bytes); } catch { return; } // not ours / damaged
    if (!doc || doc.game !== cfg.game || !doc.keys) return;
    snapshot();
    let changed = false;
    for (const [k, r] of Object.entries(doc.keys)) {
      const rule = ruleFor(k); if (!rule || typeof r.v !== 'string') continue;
      const mine = ls.get(k);
      if (mine === r.v) { meta[k] = Math.max(meta[k] || 0, r.t || 0); continue; }
      let next = null;
      if (rule.mode === 'max' && mine != null) {
        const a = parse(mine), b = parse(r.v);
        let m = deepMax(a, b);
        if (rule.skip && m && typeof m === 'object' && a && typeof a === 'object') for (const f of rule.skip) if (f in a) m[f] = a[f];
        next = typeof m === 'string' ? m : JSON.stringify(m);
      } else if ((r.t || 0) > (meta[k] || 0) || mine == null) {
        next = r.v;
        if (rule.skip && mine != null) { const a = parse(mine), b = parse(r.v); if (a && b && typeof a === 'object' && typeof b === 'object') { for (const f of rule.skip) if (f in a) b[f] = a[f]; next = JSON.stringify(b); } }
      }
      if (next != null && next !== mine) { ls.set(k, next); last[k] = next; meta[k] = Math.max(meta[k] || 0, r.t || 0); changed = true; }
    }
    jset(META + cfg.game, meta);
    lastSync = Date.now(); gotRemote = true; setStatus('on');
    if (changed) {
      if (cfg.idle && cfg.idle()) { location.reload(); return; }
      note('Progress from your other device arrived.', 'Reload', () => location.reload());
    }
    // ours may hold things theirs didn't (or newer): send the merged copy back
    const back = snapshot();
    if (Object.keys(back).some((k) => !doc.keys[k] || doc.keys[k].v !== back[k].v)) schedulePush(800);
  }

  // ---------- the relay connection ----------
  let libP = null;
  function loadLib() {
    if (window.mqtt) return Promise.resolve(window.mqtt);
    return libP || (libP = new Promise((res, rej) => { const s = document.createElement('script'); s.src = LIB; s.onload = () => (window.mqtt ? res(window.mqtt) : rej(new Error('no relay'))); s.onerror = () => { libP = null; rej(new Error('no relay')); }; document.head.appendChild(s); }));
  }
  async function connect() {
    if (!acc || relay.length) return;
    setStatus('connecting');
    let mqtt; try { mqtt = await loadLib(); } catch { setStatus('offline'); return; }
    const topic = TOPIC + (await idP) + '/' + cfg.game;
    for (const url of BROKERS) {
      const c = mqtt.connect(url, { clientId: 'gs-' + Math.random().toString(36).slice(2, 12), clean: true, reconnectPeriod: 6000, connectTimeout: 9000, keepalive: 50 });
      c.on('connect', () => { c.subscribe(topic, { qos: 1 }); setStatus('on'); if (pending) { pending = false; schedulePush(2500); } });
      c.on('message', (t, msg) => { if (t === topic) receive(msg).catch(() => {}); });
      c.on('offline', () => { if (!relay.some((x) => x.connected)) setStatus('offline'); });
      c.on('error', () => {});
      relay.push(c);
    }
    // nothing came back from the relay (first device, or nobody has synced this game yet): post ours
    setTimeout(() => { if (!gotRemote) schedulePush(0); }, 6000);
  }
  function disconnect() { for (const c of relay) { try { c.end(true); } catch { /* gone */ } } relay = []; }

  // ---------- turning it on / joining / off ----------
  function start(code, mode) {
    acc = { code: fmt(code), since: Date.now() }; jset(ACC, acc);
    deriveFrom(acc.code); meta = {}; last = {};
    if (mode === 'join') { for (const k of syncedKeys()) meta[k] = 0; }
    snapshot(mode === 'join' ? 'join' : true);
    pending = true; gotRemote = false; connect();
  }
  function stop() { acc = null; ls.set(ACC, null); disconnect(); setStatus('off'); }

  // ---------- accounts (the Game Library's sign-in) ----------
  // A gamertag (Name#1234) and a password make the sync code (PBKDF2, slow on purpose), so signing in on
  // any device lands on the same encrypted progress. No server ever sees the password. Forgotten = gone.
  async function accountCode(tag, password) {
    const base = await crypto.subtle.importKey('raw', te.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: te.encode('mmgames-account-v1:' + String(tag).toLowerCase()), iterations: 250000 }, base, 160));
    return fmt([...bits].map((x) => ALPHA[x & 31]).join(''));
  }
  // a retained message on the relays, or null after a short wait
  async function peek(topic, ms = 3500) {
    const clients = await lbConnect();
    return new Promise((res) => {
      let done = false;
      const fin = (v) => { if (done) return; done = true; for (const c of clients) { c.unsubscribe(topic); c.removeListener('message', on); } res(v); };
      const on = (t, msg) => { if (t === topic && msg && msg.length) fin(new Uint8Array(msg)); };
      for (const c of clients) { c.on('message', on); c.subscribe(topic, { qos: 1 }); }
      setTimeout(() => fin(null), ms);
    });
  }
  async function post(topic, body) {
    const clients = await lbConnect();
    const send = (c) => c.publish(topic, body, { qos: 1, retain: true });
    for (const c of clients) { if (c.connected) send(c); else c.once('connect', () => send(c)); }
  }
  // has this code ever synced the given game? 'ok' (and it opens with this code) or 'none'
  async function probe(code, game) {
    const c = clean(code), id = hex(await sha('id:' + c)).slice(0, 32);
    const key = await crypto.subtle.importKey('raw', await sha('key:' + c), 'AES-GCM', false, ['decrypt']);
    const bytes = await peek(TOPIC + id + '/' + game);
    if (!bytes) return 'none';
    try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)); return 'ok'; } catch { return 'none'; }
  }
  // gamertags: a public marker per tag (hashed) so a new account doesn't pick a tag someone has
  const TAGS = 'mmgames/v1/tag/';
  const tagTopic = async (tag) => TAGS + hex(await sha('tag:' + String(tag).toLowerCase())).slice(0, 32);
  const tagTaken = async (tag) => !!(await peek(await tagTopic(tag), 3000));
  const claimTag = async (tag) => post(await tagTopic(tag), JSON.stringify({ t: Date.now() }));
  function signIn(code, tag, mode) {
    if (acc) { disconnect(); }
    start(code, mode === 'new' ? 'new' : 'join');
    acc.tag = tag; jset(ACC, acc);
    if (tag) ls.set('gamesync.name', tag.slice(0, 16));
    if (mode === 'new') schedulePush(400);
    setStatus(status);
  }

  // ---------- UI ----------
  const CSS = `
.gs-wrap{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;background:rgba(0,0,0,.62);font:15px/1.45 system-ui,"Segoe UI",sans-serif;color:#eee;padding:16px}
.gs-box{width:min(440px,100%);max-height:calc(100vh - 32px);overflow:auto;background:#17181c;border:1px solid #3a3d46;border-radius:14px;padding:20px 22px;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.gs-box h2{margin:0 0 6px;font-size:20px}.gs-box p{margin:8px 0;color:#c8cad0}.gs-small{font-size:13px;color:#9a9ca4!important}
.gs-code{font:700 20px/1.2 ui-monospace,Consolas,monospace;letter-spacing:1px;background:#0e0f12;border:1px dashed #555;border-radius:8px;padding:10px;text-align:center;user-select:all;margin:10px 0}
.gs-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.gs-row button,.gs-btn{font:600 14px system-ui,sans-serif;padding:9px 14px;border-radius:9px;border:1px solid #4a4d57;background:#262830;color:#eee;cursor:pointer}
.gs-row button:hover{background:#30333c}.gs-row button.gs-main{background:#3b6cf0;border-color:#3b6cf0}.gs-row button.gs-danger{color:#ff8a80}
.gs-input{width:100%;box-sizing:border-box;font:700 18px ui-monospace,Consolas,monospace;padding:9px;border-radius:8px;border:1px solid #4a4d57;background:#0e0f12;color:#fff;text-transform:uppercase;margin-top:8px}
.gs-qr{display:block;width:150px;height:150px;margin:6px auto;background:#fff;padding:6px;border-radius:6px}
.gs-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:#777}.gs-dot.on{background:#4caf50}.gs-dot.connecting{background:#e0b030}.gs-dot.offline{background:#e05030}
.gs-note{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483001;background:#17181c;color:#eee;border:1px solid #3a3d46;border-radius:10px;padding:10px 14px;font:14px system-ui,sans-serif;display:flex;gap:12px;align-items:center;box-shadow:0 8px 30px rgba(0,0,0,.5);max-width:calc(100vw - 32px)}
.gs-ach{position:fixed;right:18px;top:18px;z-index:2147483002;background:#1b1a14;border:1px solid #c9a227;border-radius:12px;padding:10px 14px;color:#f3e7c0;font:14px system-ui,sans-serif;display:grid;gap:2px;max-width:min(320px,calc(100vw - 36px));box-shadow:0 10px 30px rgba(0,0,0,.55);transform:translateX(130%);transition:transform .35s ease}
.gs-ach.show{transform:none}.gs-ach b{color:#ffd65a;font-size:15px}.gs-ach span{color:#cfc7a8}
.gs-lb{margin:8px 0;padding-left:26px}.gs-lb li{display:flex;gap:10px;align-items:baseline;padding:4px 0;border-bottom:1px solid #2a2c33}.gs-lb li span{flex:1}.gs-lb li b{color:#ffd65a}.gs-lb li small{color:#9a9ca4;font-size:12px}.gs-lb li.me span{color:#8fb4ff;font-weight:700}
.gs-name{font-size:15px!important;width:60%!important;display:inline-block;margin:0 0 0 6px!important;padding:5px 8px!important;text-transform:none!important}
.gs-badge{font:800 10px system-ui,sans-serif;font-style:normal;letter-spacing:.08em;padding:1px 6px;border-radius:5px;vertical-align:2px;background:#3b6cf0;color:#fff}.gs-badge.owner{background:#c9a227;color:#1b1a14}
.gs-ban{font:600 11px system-ui,sans-serif;color:#ff8a80;padding:1px 6px;margin-left:4px;border-radius:5px;border:1px solid #4a4d57;background:#262830;cursor:pointer}
.gs-note button{font:600 13px system-ui,sans-serif;padding:6px 10px;border-radius:7px;border:0;background:#3b6cf0;color:#fff;cursor:pointer}`;
  let styled = false;
  const style = () => { if (styled) return; styled = true; const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); };
  function note(text, btn, fn) {
    style();
    document.querySelector('.gs-note')?.remove();
    const n = document.createElement('div'); n.className = 'gs-note'; n.textContent = text;
    if (btn) { const b = document.createElement('button'); b.textContent = btn; b.onclick = () => { n.remove(); fn(); }; n.appendChild(b); }
    document.body.appendChild(n); setTimeout(() => n.remove(), 12000);
  }
  const linkFor = (code) => location.origin + location.pathname + '?sync=' + clean(code);
  const ago = (t) => { if (!t) return 'not yet'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };

  function panel(view) {
    style();
    document.querySelector('.gs-wrap')?.remove();
    const w = document.createElement('div'); w.className = 'gs-wrap'; w.setAttribute('role', 'dialog');
    const box = document.createElement('div'); box.className = 'gs-box'; w.appendChild(box);
    const close = () => { w.remove(); onChange = onChange.filter((f) => f !== redraw); document.removeEventListener('keydown', esc, true); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
    w.addEventListener('click', (e) => { if (e.target === w) close(); });
    document.addEventListener('keydown', esc, true);
    function redraw() {
      if (acc) {
        let qr = ''; try { qr = qrSvg(linkFor(acc.code), { dark: '#000', light: '#fff' }).replace('<svg', '<svg class="gs-qr"'); } catch { /* too long */ }
        box.innerHTML = `<h2>☁ Sync is on</h2>
          <p><span class="gs-dot ${status}"></span>${status === 'on' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Offline (it catches up when you’re back online)'} · last synced ${ago(lastSync)}</p>
          <p>To play on another device, open this game there and enter this code under Sync, or scan / open the link:</p>
          <div class="gs-code">${acc.code}</div>${qr}
          <p class="gs-small">Your progress and best scores sync (in every game on this site). Settings stay on each device. Keep the code private: anyone with it shares your progress.</p>
          <div class="gs-row"><button class="gs-main" data-a="now">Sync now</button><button data-a="copy">Copy link</button><button class="gs-danger" data-a="off">Turn off here</button><button data-a="close">Close</button></div>`;
      } else if (view === 'join') {
        box.innerHTML = `<h2>Enter your sync code</h2><p>It's shown under Sync on the device you already play on.</p>
          <input class="gs-input" maxlength="24" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false">
          <p class="gs-small">This device's progress is merged with that one's.</p>
          <div class="gs-row"><button class="gs-main" data-a="join">Join</button><button data-a="back">Back</button></div>`;
        const inp = box.querySelector('input'); setTimeout(() => inp.focus(), 30);
        inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') box.querySelector('[data-a=join]').click(); });
        inp.addEventListener('keyup', (e) => e.stopPropagation());
      } else {
        box.innerHTML = `<h2>☁ Sync your progress</h2>
          <p>Play on your PC, laptop and phone with the same progress. No account or email: you get a code to enter on your other devices.</p>
          <div class="gs-row"><button class="gs-main" data-a="new">Turn on sync</button><button data-a="have">I have a code</button><button data-a="close">Close</button></div>`;
      }
    }
    box.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
      if (a === 'close') close();
      else if (a === 'new') { start(newCode(), 'new'); redraw(); }
      else if (a === 'have') { view = 'join'; redraw(); }
      else if (a === 'back') { view = null; redraw(); }
      else if (a === 'join') {
        const v = box.querySelector('input').value;
        if (!valid(v)) { box.querySelector('.gs-small').textContent = 'That code doesn’t look right: it’s 20 letters and numbers.'; return; }
        start(v, 'join'); view = null; redraw();
      } else if (a === 'now') { publish().catch(() => {}); redraw(); }
      else if (a === 'copy') { try { await navigator.clipboard.writeText(linkFor(acc.code)); e.target.textContent = 'Copied'; } catch { prompt('Copy this link:', linkFor(acc.code)); } }
      else if (a === 'off') { if (confirm('Stop syncing on this device? Your progress here stays; it just stops updating.')) { stop(); redraw(); } }
    });
    onChange.push(redraw);
    redraw();
    document.body.appendChild(w);
  }

  // ---------- start-up ----------
  function init(c) {
    cfg = c; meta = jget(META + cfg.game, {});
    // a sync link (?sync=CODE): offer to join, then tidy the address
    const q = new URLSearchParams(location.search).get('sync');
    if (q && valid(q)) {
      history.replaceState(null, '', location.pathname + location.search.replace(/[?&]sync=[^&]*/, '').replace(/^&/, '?') + location.hash);
      if (!acc || clean(acc.code) !== clean(q)) {
        setTimeout(() => { if (confirm('Sync this device with the code from your other device? Your progress here is merged with it.')) { if (acc) stop(); start(q, 'join'); panel(); } }, 400);
      }
    }
    if (acc) {
      deriveFrom(acc.code);
      for (const k of syncedKeys()) { const v = ls.get(k); if (v != null) { last[k] = v; if (meta[k] === undefined) meta[k] = Date.now(); } }
      connect();
    }
    // watch for progress changes (the games write storage directly)
    setInterval(() => { if (!acc || !relay.length) return; const before = JSON.stringify(meta); snapshot(); if (JSON.stringify(meta) !== before) schedulePush(2000); }, 4000);
    document.addEventListener('visibilitychange', () => { if (document.hidden && acc) publish().catch(() => {}); });
    // achievements: rules that read the game's saves are checked now and every few seconds
    if (cfg.ach && cfg.ach.length) { setTimeout(() => checkAch(true), 1500); setInterval(() => checkAch(false), 3000); }
  }

  // ---------- achievements ----------
  // Stored per game in 'gamesach.<game>' = { id: { n: name, d: description, t: when } } (synced, and read by the
  // Game Library's Profile page). A rule's `test(get)` gets parsed saves: get('some-key') -> value or null.
  const achKey = () => 'gamesach.' + cfg.game;
  const getJ = (k) => { const v = ls.get(k); if (v == null) return null; try { return JSON.parse(v); } catch { return v; } };
  function unlock(id, quiet) {
    if (!cfg || !cfg.ach) return false;
    const a = cfg.ach.find((x) => x.id === id); if (!a) return false;
    const got = jget(achKey(), {}); if (got[id]) return false;
    got[id] = { n: a.name, d: a.desc, t: Date.now() }; jset(achKey(), got);
    if (!quiet) achToast(a);
    return true;
  }
  function checkAch(first) {
    const got = jget(achKey(), {}), fresh = [];
    for (const a of cfg.ach) { if (got[a.id] || !a.test) continue; let ok = false; try { ok = !!a.test(getJ); } catch { /* bad save */ } if (ok && unlock(a.id, true)) fresh.push(a); }
    if (!fresh.length) return;
    if (first && fresh.length > 1) note('🏆 ' + fresh.length + ' achievements from your progress so far');
    else for (const a of fresh) achToast(a);
  }
  let achQ = [], achBusy = false;
  function achToast(a) {
    achQ.push(a); if (achBusy) return; achBusy = true; style();
    const next = () => {
      const x = achQ.shift(); if (!x) { achBusy = false; return; }
      const el = document.createElement('div'); el.className = 'gs-ach';
      el.innerHTML = '<b>🏆 ' + escH(x.name) + '</b><span>' + escH(x.desc || '') + '</span>';
      document.body.appendChild(el); setTimeout(() => el.classList.add('show'), 20);
      setTimeout(() => { el.classList.remove('show'); setTimeout(() => { el.remove(); next(); }, 400); }, 3600);
    };
    next();
  }
  const escH = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---------- leaderboards (daily challenges) ----------
  // Each player's best for a board is a retained message at mmgames/v1/lb/<game>/<board>/<player>. Public and
  // unsigned (it's for friends, not a contest). Names are shared by every game: 'gamesync.name'.
  const LB = 'mmgames/v1/lb/';
  const pid = () => { let p = ls.get('gamesync.pid'); if (!p) { p = hex(crypto.getRandomValues(new Uint8Array(8))); ls.set('gamesync.pid', p); } return p; };
  // signed in: always the account's gamertag (with the capitals it was made with, which the library stores in the name)
  const myName = () => { const t = acc && acc.tag, n = ls.get('gamesync.name') || ''; return (t ? (n.toLowerCase() === t.toLowerCase() ? n : t) : n).slice(0, 16); };
  let lbP = null;
  function lbConnect() {
    if (lbP) return lbP;
    lbP = loadLib().then((mqtt) => BROKERS.map((url) => { const c = mqtt.connect(url, { clientId: 'lb-' + Math.random().toString(36).slice(2, 12), clean: true, reconnectPeriod: 8000, connectTimeout: 9000 }); c.on('error', () => {}); return c; }));
    lbP.catch(() => { lbP = null; });
    return lbP;
  }
  async function lbPost(board, score, info) {
    const best = Number(ls.get('gamesync.lb.' + cfg.game + '.' + board)) || 0;
    if (!(score > best) || !myName()) return false;
    ls.set('gamesync.lb.' + cfg.game + '.' + board, String(score));
    const clients = await lbConnect();
    const row = { n: myName(), s: score, i: String(info || '').slice(0, 40), t: Date.now() };
    try { const m = await me(); if (m && lower(m.tag) === lower(row.n)) { const sg = await sign(m.k, { m: rowMsg(cfg.game, board, pid(), row) }); row.sig = sg.s; row.sp = sg.p; row.x = m.x; } } catch { /* post unsigned */ }
    const body = JSON.stringify(row);
    const topic = LB + cfg.game + '/' + board + '/' + pid();
    const send = (c) => c.publish(topic, body, { qos: 1, retain: true });
    for (const c of clients) { if (c.connected) send(c); else c.once('connect', () => send(c)); }
    return true;
  }
  async function lbTop(board, n = 10) {
    const clients = await lbConnect();
    const topic = LB + cfg.game + '/' + board + '/+', rows = new Map();
    const checks = Promise.all([staff().catch(() => []), bans().catch(() => new Map())]);
    const onMsg = (t, msg) => {
      if (!t.startsWith(LB + cfg.game + '/' + board + '/')) return;
      try { const r = JSON.parse(new TextDecoder().decode(msg)); const s = Number(r.s); if (!Number.isFinite(s) || s <= 0 || s > 1e9) return;
        const who = t.slice(t.lastIndexOf('/') + 1), prev = rows.get(who); if (!prev || s > prev.s) rows.set(who, { n: String(r.n || '?').slice(0, 16), s, i: String(r.i || '').slice(0, 40), me: who === pid(), pid: who, raw: r }); } catch { /* junk */ }
    };
    for (const c of clients) { c.on('message', onMsg); c.subscribe(topic); }
    await new Promise((r) => setTimeout(r, 2600));
    for (const c of clients) { c.unsubscribe(topic); c.removeListener('message', onMsg); }
    const [st, bn] = await checks, out = [];
    for (const r of rows.values()) {
      const who = st.find((p) => lower(p.tag) === lower(r.n));
      if (!who && banned(bn, r.pid, r.n)) continue; // staff can't be banned off the boards
      if (who) {
        const ok = r.raw.x === who.x && r.raw.sp && (await verify({ p: r.raw.sp, s: r.raw.sig }, who.x, who.y))?.m === rowMsg(cfg.game, board, r.pid, r.raw);
        if (!ok) continue; // someone using a staff member's name
        r.badge = who.role;
      }
      delete r.raw; out.push(r);
    }
    return out.sort((a, b) => b.s - a.s).slice(0, n);
  }
  // The board panel: today's top 10, and a name box (your score is posted once you have a name).
  function board(boardId, title, mine) {
    style();
    document.querySelector('.gs-wrap')?.remove();
    const w = document.createElement('div'); w.className = 'gs-wrap';
    const box = document.createElement('div'); box.className = 'gs-box'; w.appendChild(box);
    const close = () => { w.remove(); document.removeEventListener('keydown', esc, true); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
    document.addEventListener('keydown', esc, true);
    w.addEventListener('click', (e) => { if (e.target === w) close(); });
    const draw = (rows, msg) => {
      box.innerHTML = `<h2>🏆 ${escH(title)}</h2>${msg ? `<p class="gs-small">${escH(msg)}</p>` : ''}
        ${rows ? (rows.length ? `<ol class="gs-lb">${rows.map((r) => `<li class="${r.me ? 'me' : ''}"><span>${escH(r.n)}${r.badge ? ` <em class="gs-badge ${r.badge}">${r.badge === 'owner' ? 'OWNER' : 'MOD'}</em>` : ''}${staffMe && !r.me && !r.badge ? ` <button class="gs-ban" data-ban="${escH(r.pid)}" data-n="${escH(r.n)}" title="Ban from every leaderboard">Ban</button>` : ''}</span><b>${Math.floor(r.s).toLocaleString()}</b>${r.i ? `<small>${escH(r.i)}</small>` : ''}</li>`).join('')}</ol>` : '<p>No scores yet today. Be the first.</p>') : '<p>Loading today’s scores…</p>'}
        ${acc && acc.tag ? `<p class="gs-small">You're on the boards as <b>${escH(myName())}</b> (your Game Library account).</p><div class="gs-row"><button data-a="close">Close</button></div>`
          : `<p class="gs-small">Your name on the boards (every game): <input class="gs-input gs-name" maxlength="16" value="${escH(myName())}" placeholder="Name"></p>
        <div class="gs-row"><button class="gs-main" data-a="save">Save name</button><button data-a="close">Close</button></div>`}`;
      box.querySelectorAll('[data-ban]').forEach((b) => { b.onclick = async () => { const why = prompt('Ban ' + b.dataset.n + ' from every leaderboard? Reason (shown to staff only):', ''); if (why === null) return; try { await setBan('pid:' + b.dataset.ban, true, why, b.dataset.n); await post(LB + cfg.game + '/' + boardId + '/' + b.dataset.ban, ''); load('Banned ' + b.dataset.n + '.'); } catch { load('Couldn’t ban (are you still staff?).'); } }; });
      box.querySelector('[data-a=close]').onclick = close;
      const inp = box.querySelector('.gs-name'); if (!inp) return;
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') box.querySelector('[data-a=save]').click(); });
      inp.addEventListener('keyup', (e) => e.stopPropagation());
      box.querySelector('[data-a=save]').onclick = async () => {
        const v = inp.value.trim().replace(/[^\w .\-'!?#]/g, '').slice(0, 16); if (!v) return;
        if ((await staff().catch(() => [])).some((p) => lower(p.tag) === lower(v))) { load('That name belongs to a staff member. Pick another.'); return; }
        ls.set('gamesync.name', v);
        if (mine && mine.score > 0) await lbPost(boardId, mine.score, mine.info).catch(() => {});
        load('Saved. Updating…');
      };
    };
    let staffMe = null;
    const load = async (msg) => { draw(null, msg); staffMe = await me().catch(() => null); try { const rows = await lbTop(boardId); draw(rows, myName() ? '' : 'Pick a name to put your score on the board.'); } catch { draw([], 'Couldn’t reach the scoreboard. Check your connection.'); } };
    document.body.appendChild(w);
    (async () => { if (mine && mine.score > 0 && myName()) await lbPost(boardId, mine.score, mine.info).catch(() => {}); load(); })();
  }

  // ---------- staff: the owner and moderators ----------
  // There's no server, so authority comes from signatures. The owner's public key is below; the owner signs
  // the list of moderators (each with their own key), and every ban, announcement and gift is signed by
  // whoever made it. Everyone's browser checks the signatures, so a faked message is simply ignored.
  // A staff key is pasted once (owner key / moderator invite) and syncs through that person's account.
  const OWNER = { tag: 'GIGACHAD#8122', x: 'v4TcFLCKDh2Y8V8xIn4lZkXB5Kbbv9pHmTPOTo_6fG8', y: 'aDJQcqtUc0OJBy-sfwOv6WMfK9TDb-wU2CszcRbbN-s' };
  const MOD = 'mmgames/v1/mod/', STAFFKEY = 'gamelib.staffkey';
  const ub = (str) => { const b = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
  const bu = (u) => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const EC = { name: 'ECDSA', namedCurve: 'P-256' }, SIG = { name: 'ECDSA', hash: 'SHA-256' };
  const vkeys = new Map();
  const verifyKey = (x, y) => { const k = x + y; if (!vkeys.has(k)) vkeys.set(k, crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y, ext: true }, EC, false, ['verify'])); return vkeys.get(k); };
  async function verify(env, x, y) {
    try { if (!env || typeof env.p !== 'string' || typeof env.s !== 'string') return null;
      return (await crypto.subtle.verify(SIG, await verifyKey(x, y), ub(env.s), te.encode(env.p))) ? JSON.parse(env.p) : null; } catch { return null; }
  }
  // a pasted key: OWNER-... or MOD-... = base64url(d | x | y)
  async function parseKey(code) {
    const m = String(code || '').trim().match(/^(OWNER|MOD)-([A-Za-z0-9_-]{120,140})$/); if (!m) return null;
    const u = ub(m[2]); if (u.length !== 96) return null;
    const x = bu(u.slice(32, 64)), y = bu(u.slice(64));
    try { const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: bu(u.slice(0, 32)), x, y, ext: true }, EC, false, ['sign']); return { kind: m[1], key, x, y }; } catch { return null; }
  }
  const sign = async (k, obj) => { const p = JSON.stringify(obj); return { p, s: bu(new Uint8Array(await crypto.subtle.sign(SIG, k.key, te.encode(p)))), x: k.x }; };
  const lower = (t) => String(t || '').toLowerCase();
  const short = async (t) => hex(await sha(t)).slice(0, 24);
  // every retained message under a topic filter, collected for a moment
  async function collect(filter, ms = 2600) {
    const clients = await lbConnect(), got = new Map(), base = filter.replace(/[+#].*$/, '');
    const on = (t, msg) => { if (t.startsWith(base) && msg && msg.length) got.set(t, td.decode(msg)); };
    for (const c of clients) { c.on('message', on); c.subscribe(filter, { qos: 1 }); }
    await new Promise((r) => setTimeout(r, ms));
    for (const c of clients) { c.unsubscribe(filter); c.removeListener('message', on); }
    return got;
  }
  const jparse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const fresh = (box, ms, fn) => { if (!box.p || Date.now() - box.t > ms) { box.t = Date.now(); box.p = fn(); box.p.catch(() => { box.p = null; }); } return box.p; };
  // who is staff: [{ tag, x, y, role }]
  const staffBox = {};
  function staff(force) {
    if (force) staffBox.p = null;
    return fresh(staffBox, 60000, async () => {
      const list = [{ tag: OWNER.tag, x: OWNER.x, y: OWNER.y, role: 'owner' }];
      const raw = (await collect(MOD + 'roles', 2200)).get(MOD + 'roles');
      const doc = raw && await verify(jparse(raw), OWNER.x, OWNER.y);
      for (const m of (doc && doc.mods) || []) if (m && m.tag && m.x && m.y) list.push({ tag: String(m.tag), x: m.x, y: m.y, role: 'mod' });
      return list;
    });
  }
  // this device's staff key, if it has one that is (still) on the staff list
  async function me() {
    const k = await parseKey(ls.get(STAFFKEY)); if (!k) return null;
    const who = (await staff()).find((p) => p.x === k.x && p.y === k.y);
    return who ? { ...who, k } : null;
  }
  async function setStaffKey(code) {
    const k = await parseKey(code); if (!k) return 'That isn’t a staff key.';
    const who = (await staff(true)).find((p) => p.x === k.x && p.y === k.y);
    if (!who) return k.kind === 'OWNER' ? 'That owner key doesn’t match.' : 'That invite isn’t on the moderator list (it may have been removed).';
    if (acc && acc.tag && lower(acc.tag) !== lower(who.tag)) return 'That key belongs to ' + who.tag + '. Sign in as them first.';
    ls.set(STAFFKEY, String(code).trim()); schedulePush(500); return null;
  }
  // bans: each staff member keeps their own signed list; the newest word on a player wins
  const banBox = {};
  function bans(force) {
    if (force) banBox.p = null;
    return fresh(banBox, 45000, async () => {
      const [list, got] = await Promise.all([staff(), collect(MOD + 'bans/+', 2600)]);
      const out = new Map(), mine = {};
      for (const [topic, raw] of got) {
        const env = jparse(raw); if (!env) continue;
        const who = list.find((p) => p.x === env.x); if (!who) continue;
        const doc = await verify(env, who.x, who.y); if (!doc || !Array.isArray(doc.list)) continue;
        mine[topic] = doc.list;
        for (const b of doc.list) { if (!b || !b.target) continue; const prev = out.get(b.target); if (!prev || (b.t || 0) > (prev.t || 0)) out.set(b.target, { ...b, by: who.tag }); }
      }
      out.lists = mine; return out;
    });
  }
  async function setBan(target, ban, reason, name) {
    const m = await me(); if (!m) throw new Error('not staff');
    const all = await bans(true), topic = MOD + 'bans/' + await short('k:' + m.x);
    const list = (all.lists[topic] || []).filter((b) => b.target !== target);
    list.push({ target, ban: !!ban, reason: String(reason || '').slice(0, 120), name: String(name || '').slice(0, 24), t: Date.now() });
    await post(topic, JSON.stringify(await sign(m.k, { list: list.slice(-400), t: Date.now() })));
    banBox.p = null;
  }
  const banned = (b, pidv, name) => { const a = b.get('pid:' + pidv), n = b.get('name:' + lower(name)); return !!((a && a.ban) || (n && n.ban)); };
  // owner: the moderator list
  async function setMods(mods) {
    const m = await me(); if (!m || m.role !== 'owner') throw new Error('owner only');
    await post(MOD + 'roles', JSON.stringify(await sign(m.k, { mods, t: Date.now() })));
    staffBox.p = null;
  }
  async function addMod(tag) {
    const kp = await crypto.subtle.generateKey(EC, true, ['sign', 'verify']), j = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const mods = (await staff(true)).filter((p) => p.role === 'mod' && lower(p.tag) !== lower(tag)).map(({ tag: t, x, y }) => ({ tag: t, x, y }));
    mods.push({ tag, x: j.x, y: j.y, t: Date.now() }); await setMods(mods);
    const u = new Uint8Array(96); u.set(ub(j.d), 0); u.set(ub(j.x), 32); u.set(ub(j.y), 64);
    return 'MOD-' + bu(u);
  }
  async function removeMod(tag) { await setMods((await staff(true)).filter((p) => p.role === 'mod' && lower(p.tag) !== lower(tag)).map(({ tag: t, x, y }) => ({ tag: t, x, y }))); }
  // owner: the announcement on the library, and gifts (coins and shop items) to a gamertag
  async function news() { const raw = (await collect(MOD + 'news', 2200)).get(MOD + 'news'); const d = raw && await verify(jparse(raw), OWNER.x, OWNER.y); return d && d.text ? d : null; }
  async function postNews(text) { const m = await me(); if (!m || m.role !== 'owner') throw new Error('owner only'); await post(MOD + 'news', text ? JSON.stringify(await sign(m.k, { text: String(text).slice(0, 400), t: Date.now() })) : ''); }
  const giftTopic = async (tag) => MOD + 'gift/' + await short('gift:' + lower(tag));
  async function gifts(tag) { const t = await giftTopic(tag), raw = (await collect(t, 2200)).get(t); const d = raw && await verify(jparse(raw), OWNER.x, OWNER.y); return d && lower(d.tag) === lower(tag) && Array.isArray(d.gifts) ? d.gifts : []; }
  async function giveGift(tag, g) {
    const m = await me(); if (!m || m.role !== 'owner') throw new Error('owner only');
    const list = await gifts(tag); list.push({ id: hex(crypto.getRandomValues(new Uint8Array(6))), coins: Math.round(Number(g.coins) || 0), item: g.item || null, note: String(g.note || '').slice(0, 80), t: Date.now() });
    await post(await giftTopic(tag), JSON.stringify(await sign(m.k, { tag, gifts: list.slice(-200), t: Date.now() })));
  }
  // a leaderboard row from staff carries a signature, so nobody else can post under a staff name
  const rowMsg = (game, board, pidv, r) => [game, board, pidv, r.n, r.s, r.t].join('|');

  // ---------- QR codes (from Trigger Happy's qr.js: byte mode, level M, versions 1-10) ----------
  // QR codes for share links, drawn as SVG. Byte mode, error correction level M, versions 1-10
  // (up to 213 bytes, plenty for a link). Follows ISO/IEC 18004; no library so it works offline.

  const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  const MAX_VER = 10;

  // Multiply in GF(2^8) with the QR polynomial 0x11D.
  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function rsDivisor(degree) {
    const r = new Array(degree).fill(0);
    r[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < r.length; j++) {
        r[j] = gfMul(r[j], root);
        if (j + 1 < r.length) r[j] ^= r[j + 1];
      }
      root = gfMul(root, 2);
    }
    return r;
  }

  function rsRemainder(data, div) {
    const r = div.map(() => 0);
    for (const b of data) {
      const f = b ^ r.shift();
      r.push(0);
      div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
    }
    return r;
  }

  function rawModules(ver) {
    let n = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const a = Math.floor(ver / 7) + 2;
      n -= (25 * a - 10) * a - 55;
      if (ver >= 7) n -= 36;
    }
    return n;
  }
  const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

  function alignPositions(ver, size) {
    if (ver === 1) return [];
    const n = Math.floor(ver / 7) + 2;
    const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
    const r = [6];
    for (let p = size - 7; r.length < n; p -= step) r.splice(1, 0, p);
    return r;
  }

  // Error-correction blocks, interleaved.
  function addEcc(data, ver) {
    const nb = NUM_BLOCKS[ver], ecLen = ECC_PER_BLOCK[ver], raw = Math.floor(rawModules(ver) / 8);
    const nShort = nb - raw % nb, shortLen = Math.floor(raw / nb);
    const div = rsDivisor(ecLen), blocks = [];
    for (let i = 0, k = 0; i < nb; i++) {
      const d = data.slice(k, k + shortLen - ecLen + (i < nShort ? 0 : 1));
      k += d.length;
      const ecc = rsRemainder(d, div);
      if (i < nShort) d.push(0);
      blocks.push(d.concat(ecc));
    }
    const out = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((b, j) => { if (i !== shortLen - ecLen || j >= nShort) out.push(b[i]); });
    }
    return out;
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => x * y % 2 + x * y % 3 === 0,
    (x, y) => (x * y % 2 + x * y % 3) % 2 === 0,
    (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
  ];

  // Penalty score used to pick the most readable mask.
  function penalty(m) {
    const n = m.length;
    let p = 0, dark = 0;
    const line = (get) => {
      for (let a = 0; a < n; a++) {
        let run = 1;
        for (let b = 1; b <= n; b++) {
          if (b < n && get(a, b) === get(a, b - 1)) run++;
          else { if (run >= 5) p += run - 2; run = 1; }
        }
        // Finder-like 1:1:3:1:1 with 4 light modules on one side.
        for (let b = 0; b + 10 < n; b++) {
          const s = [];
          for (let k = 0; k < 11; k++) s.push(get(a, b + k) ? 1 : 0);
          const t = s.join('');
          if (t === '10111010000' || t === '00001011101') p += 40;
        }
      }
    };
    line((a, b) => m[a][b]);
    line((a, b) => m[b][a]);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (m[y][x]) dark++;
        if (x < n - 1 && y < n - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
      }
    }
    p += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
    return p;
  }

  // Returns the module grid (rows of booleans, true = dark) for `text`.
  function qrMatrix(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    let ver = 1;
    for (; ver <= MAX_VER; ver++) {
      const cap = dataCodewords(ver) * 8, head = 4 + (ver < 10 ? 8 : 16);
      if (head + bytes.length * 8 <= cap) break;
    }
    if (ver > MAX_VER) throw new Error('Text too long for a QR code');
    const cap = dataCodewords(ver) * 8;

    const bits = [];
    const put = (v, len) => { for (let i = len - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    put(4, 4);
    put(bytes.length, ver < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

    const size = ver * 4 + 17;
    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };

    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
          if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const al = alignPositions(ver, size), last = al.length - 1;
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    const formatBits = (mask) => {
      const d = mask; // level M = 00
      let r = d;
      for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      const f = ((d << 10) | r) ^ 0x5412, bit = (i) => ((f >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    formatBits(0);
    if (ver >= 7) {
      let r = ver;
      for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
      const v = (ver << 12) | r;
      for (let i = 0; i < 18; i++) {
        const d = ((v >>> i) & 1) === 1, a = size - 11 + i % 3, b = Math.floor(i / 3);
        set(a, b, d); set(b, a, d);
      }
    }

    const cw = addEcc(data, ver);
    let k = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < size; v++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
          if (!fn[y][x] && k < cw.length * 8) { mod[y][x] = ((cw[k >>> 3] >>> (7 - (k & 7))) & 1) === 1; k++; }
        }
      }
    }

    let best = null, bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      formatBits(m);
      const g = mod.map((row, y) => row.map((d, x) => (!fn[y][x] && MASKS[m](x, y)) ? !d : d));
      const s = penalty(g);
      if (s < bestScore) { bestScore = s; best = g; }
    }
    return best;
  }

  // SVG markup: dark modules on white with the standard 4-module quiet zone.
  function qrSvg(text, { dark = '#000', light = '#fff' } = {}) {
    const m = qrMatrix(text), n = m.length + 8;
    let d = '';
    m.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">`
      + `<rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
  }


  window.GameSync = { init, open: panel, get on() { return !!acc; }, get status() { return status; },
    unlock: (id) => unlock(id), board, postScore: (b, s, i) => lbPost(b, s, i).catch(() => false),
    get account() { return acc ? { tag: acc.tag || null, since: acc.since } : null; }, accountCode, probe, tagTaken, claimTag, signIn, signOut: stop,
    syncNow: () => publish().catch(() => {}), onStatus: (f) => onChange.push(f),
    staff: { OWNER, list: staff, me, setKey: setStaffKey, clearKey: () => ls.set(STAFFKEY, ''), bans, setBan, addMod, removeMod, news, postNews, gifts, giveGift } };
})();
