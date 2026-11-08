// BONK BOWL: 3-player local sumo on one device.
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('bonkbowl.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bonkbowl.' + k, JSON.stringify(v)); } catch {} },
};
const settings = { controllers: store.get('controllers', true), target: store.get('target', 5) };

const SLOTS = [
  { name: 'RED',  color: 0xff4d5e, css: '#ff4d5e', hint: 'Move W A S D<br>Dash Q',
    keys: { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], dash: ['KeyQ'] } },
  { name: 'BLUE', color: 0x3fa9ff, css: '#3fa9ff', hint: 'Move I J K L<br>Dash U',
    keys: { up: ['KeyI'], down: ['KeyK'], left: ['KeyJ'], right: ['KeyL'], dash: ['KeyU'] } },
  { name: 'GOLD', color: 0xffc62e, css: '#ffc62e', hint: 'Move Arrow keys<br>Dash Enter / Numpad 0',
    keys: { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], dash: ['Enter', 'NumpadEnter', 'Numpad0', 'Slash'] } },
];
const slotState = ['empty', 'empty', 'empty']; // empty | human | cpu

// ---------------- input ----------------
const held = new Set(), pressed = new Set();
const GAME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Slash', 'Enter', 'Backspace']);
addEventListener('keydown', (e) => {
  audio();
  if (GAME_KEYS.has(e.code)) e.preventDefault();
  if (!e.repeat) pressed.add(e.code);
  held.add(e.code);
});
addEventListener('keyup', (e) => held.delete(e.code));
addEventListener('blur', () => held.clear());
addEventListener('pointerdown', () => audio());
const anyHeld = (codes) => codes.some((c) => held.has(c));
const anyPressed = (codes) => codes.some((c) => pressed.has(c));

// Gamepads: standard-mapping pads only, never wheels/joysticks, sticks count only after being seen centred.
const BAD_PAD = /wheel|joystick|flight|pedal|tablet|throttle|rudder|hotas|stick/i;
const pads = new Map(); // gamepad index -> state
function pollPads() {
  const seen = new Set();
  const list = settings.controllers && navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of list) {
    if (!gp || !gp.connected || gp.mapping !== 'standard' || BAD_PAD.test(gp.id)) continue;
    seen.add(gp.index);
    let st = pads.get(gp.index);
    if (!st || st.id !== gp.id) { st = { id: gp.id, centred: false, prev: [], now: [], slot: -1, move: { x: 0, y: 0 } }; pads.set(gp.index, st); }
    st.prev = st.now;
    st.now = gp.buttons.map((b) => !!(b && b.pressed));
    const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
    if (Math.abs(ax) < 0.2 && Math.abs(ay) < 0.2) st.centred = true;
    let mx = 0, my = 0;
    if (st.centred) { const m = Math.hypot(ax, ay); if (m > 0.25) { mx = ax / Math.max(1, m); my = ay / Math.max(1, m); } }
    if (st.now[12]) my = -1; if (st.now[13]) my = 1; if (st.now[14]) mx = -1; if (st.now[15]) mx = 1;
    st.move = { x: mx, y: my };
  }
  for (const [idx, st] of pads) if (!seen.has(idx)) { pads.delete(idx); if (st.slot >= 0 && state === 'lobby') slotState[st.slot] = 'empty', renderLobby(); }
}
const padPressed = (st, i) => st.now[i] && !st.prev[i];
const padForSlot = (i) => { for (const st of pads.values()) if (st.slot === i) return st; return null; };
const anyPadPressed = (...btns) => { for (const st of pads.values()) for (const b of btns) if (padPressed(st, b)) return true; return false; };

function slotInput(i) {
  const k = SLOTS[i].keys;
  let x = 0, y = 0;
  if (anyHeld(k.left)) x -= 1; if (anyHeld(k.right)) x += 1;
  if (anyHeld(k.up)) y -= 1; if (anyHeld(k.down)) y += 1;
  let dash = anyPressed(k.dash);
  const pad = padForSlot(i);
  if (pad) {
    x += pad.move.x; y += pad.move.y;
    if (padPressed(pad, 0) || padPressed(pad, 2) || padPressed(pad, 5) || padPressed(pad, 7)) dash = true;
  }
  const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
  return { x, y, dash };
}

// ---------------- audio ----------------
let ac = null, master = null;
function audio() {
  if (!ac) {
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); master = ac.createGain(); master.gain.value = 0.6; master.connect(ac.destination); }
    catch { return null; }
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}
function tone(f, dur, type = 'sine', vol = 0.2, to = null, delay = 0) {
  if (!ac) return;
  const t = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, vol, freq) {
  if (!ac) return;
  const t = ac.currentTime, len = Math.floor(ac.sampleRate * dur), buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
  s.buffer = buf; f.type = 'lowpass'; f.frequency.value = freq; g.gain.value = vol;
  s.connect(f); f.connect(g); g.connect(master); s.start(t);
}
const sfx = {
  bonk(s) { const v = Math.min(0.45, 0.12 + s * 0.02); tone(140 + s * 9, 0.22, 'sine', v, 60); tone(320 + s * 12, 0.08, 'triangle', v * 0.5, 180); },
  dash() { noise(0.16, 0.18, 2200); },
  fall() { tone(620, 1.0, 'triangle', 0.16, 70); },
  crumble() { noise(0.45, 0.14, 380); },
  pickup() { [0, 4, 7, 12].forEach((n, i) => tone(523 * 2 ** (n / 12), 0.14, 'square', 0.08, null, i * 0.06)); },
  quake() { tone(90, 0.6, 'sawtooth', 0.22, 30); noise(0.5, 0.25, 600); },
  beep(hi) { tone(hi ? 880 : 440, hi ? 0.35 : 0.15, 'square', 0.1); },
  win() { [0, 4, 7, 12, 7, 12].forEach((n, i) => tone(392 * 2 ** (n / 12), 0.22, 'triangle', 0.16, null, i * 0.11)); },
};

// ---------------- scene ----------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1d1840);
scene.fog = new THREE.Fog(0x1d1840, 34, 80);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
const camBase = new THREE.Vector3(0, 19, 15.5);
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  const far = camera.aspect < 1.2 ? 1.2 / camera.aspect : 1; // portrait / narrow screens pull back
  camBase.set(0, 19 * far, 15.5 * far);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

scene.add(new THREE.HemisphereLight(0xd8ecff, 0x46305e, 1.0));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.7);
sun.position.set(7, 16, 9);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -13, right: 13, top: 13, bottom: -13, near: 1, far: 50 });
scene.add(sun);

{ // stars + floating rocks for atmosphere
  const n = 700, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(70 + Math.random() * 30);
    if (v.y < -10) v.y = -v.y * 0.3;
    pos.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 0.35, fog: false })));
}
const rocks = [];
{
  const mat = new THREE.MeshStandardMaterial({ color: 0x5b4a6e, roughness: 1, flatShading: true });
  for (let i = 0; i < 9; i++) {
    const m = new THREE.Mesh(new THREE.DodecahedronGeometry(0.6 + Math.random() * 1.4, 0), mat);
    const a = (i / 9) * Math.PI * 2, r = 15 + Math.random() * 8;
    m.userData = { a, r, y: -4 - Math.random() * 6, s: 0.03 + Math.random() * 0.05 };
    scene.add(m); rocks.push(m);
  }
}

// ---------------- arena (hex tiles) ----------------
const S = 1.15, N = 4, SQ3 = Math.sqrt(3);
const tiles = [], tileMap = new Map();
const sideMat = new THREE.MeshStandardMaterial({ color: 0x7a5640, roughness: 0.95, flatShading: true });
const botMat = new THREE.MeshStandardMaterial({ color: 0x3f2c26, roughness: 1, flatShading: true });
const tileGeo = new THREE.CylinderGeometry(S * 0.965, S * 0.7, 1.1, 6, 1);
tileGeo.translate(0, -0.55, 0);
for (let q = -N; q <= N; q++) for (let r = -N; r <= N; r++) {
  const ring = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
  if (ring > N) continue;
  const base = new THREE.Color(ring === 0 ? 0xc6f5d2 : ring % 2 ? 0x84dca8 : 0x9be8b8);
  const top = new THREE.MeshStandardMaterial({ color: base.clone(), roughness: 0.8, flatShading: true });
  const mesh = new THREE.Mesh(tileGeo, [sideMat, top, botMat]);
  const x = S * SQ3 * (q + r / 2), z = S * 1.5 * r;
  mesh.position.set(x, 0, z); mesh.receiveShadow = true; mesh.castShadow = true;
  scene.add(mesh);
  const t = { q, r, ring, x, z, mesh, top, base, state: 'ok', t: 0, vy: 0, spin: new THREE.Vector3() };
  tiles.push(t); tileMap.set(q + ',' + r, t);
}
function tileAt(x, z) {
  const fq = (SQ3 / 3 * x - z / 3) / S, fr = (2 / 3 * z) / S, fs = -fq - fr;
  let rq = Math.round(fq), rr = Math.round(fr); const rs = Math.round(fs);
  const dq = Math.abs(rq - fq), dr = Math.abs(rr - fr), ds = Math.abs(rs - fs);
  if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs;
  return tileMap.get(rq + ',' + rr) || null;
}
const supported = (x, z) => { const t = tileAt(x, z); return !!t && t.state !== 'gone'; };
function resetTiles() {
  for (const t of tiles) {
    t.state = 'ok'; t.t = 0; t.vy = 0;
    t.mesh.position.set(t.x, 0, t.z); t.mesh.rotation.set(0, 0, 0); t.mesh.visible = true;
    t.top.color.copy(t.base);
  }
}
let centroid = { x: 0, z: 0 };
function updateCentroid() {
  let sx = 0, sz = 0, n = 0;
  for (const t of tiles) if (t.state === 'ok') { sx += t.x; sz += t.z; n++; }
  centroid = n ? { x: sx / n, z: sz / n } : { x: 0, z: 0 };
  return n;
}

// ---------------- particles & effects ----------------
const partGeo = new THREE.IcosahedronGeometry(0.1, 0);
const matCache = new Map();
const basicMat = (c) => { if (!matCache.has(c)) matCache.set(c, new THREE.MeshBasicMaterial({ color: c })); return matCache.get(c); };
const parts = [], partPool = [];
function burst(x, y, z, color, n, spd) {
  for (let i = 0; i < n; i++) {
    const m = partPool.pop() || new THREE.Mesh(partGeo);
    m.material = basicMat(color); m.position.set(x, y, z); m.visible = true; m.scale.setScalar(0.6 + Math.random());
    const d = new THREE.Vector3().randomDirection();
    m.userData = { v: d.multiplyScalar(spd * (0.4 + Math.random())), life: 0.45 + Math.random() * 0.35 };
    m.userData.v.y = Math.abs(m.userData.v.y) + spd * 0.3;
    scene.add(m); parts.push(m);
  }
}
const waves = [];
function shockwave(x, z, color) {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.1, 48), new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, 0.1, z); scene.add(m); waves.push({ m, t: 0 });
}
let shake = 0;

// ---------------- blobs ----------------
function makeBlob(color) {
  const root = new THREE.Group(), squash = new THREE.Group(); root.add(squash);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.05, emissive: color, emissiveIntensity: 0 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 32, 20), mat);
  body.position.y = 0.55; body.castShadow = true; squash.add(body);
  const white = basicMat(0xffffff), black = basicMat(0x111111);
  for (const sx of [-0.2, 0.2]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), white); e.position.set(sx, 0.74, 0.42); e.scale.z = 0.6; squash.add(e);
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 8), black); p.position.set(sx, 0.74, 0.52); squash.add(p);
  }
  const crown = new THREE.Group(), gold = new THREE.MeshStandardMaterial({ color: 0xffd23a, metalness: 0.7, roughness: 0.25, emissive: 0x553300 });
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.14, 12, 1, true), gold); crown.add(band);
  for (let i = 0; i < 5; i++) { const s = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 6), gold); const a = i / 5 * Math.PI * 2; s.position.set(Math.sin(a) * 0.24, 0.14, Math.cos(a) * 0.24); crown.add(s); }
  crown.position.y = 1.14; crown.visible = false; squash.add(crown);
  scene.add(root);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.78, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; scene.add(ring);
  return { root, squash, mat, crown, ring };
}

let players = [];
function createPlayers() {
  for (const p of players) { scene.remove(p.g.root); scene.remove(p.g.ring); }
  players = [];
  SLOTS.forEach((s, i) => {
    if (slotState[i] === 'empty') return;
    players.push({ i, slot: s, cpu: slotState[i] === 'cpu', g: makeBlob(s.color), score: 0, kos: 0,
      ai: { think: 0, goal: { x: 0, z: 0 }, target: null, dist: 99, aggr: 2.5 + Math.random() * 1.5 } });
  });
}
function placePlayers() {
  const n = players.length;
  players.forEach((p, k) => {
    const a = Math.PI / 2 + (k / n) * Math.PI * 2;
    Object.assign(p, { x: Math.cos(a) * 3.6, z: Math.sin(a) * 3.6, y: 0, vx: 0, vz: 0, vy: 0, alive: true, falling: false,
      dashCd: 0, dashT: 0, hitT: 0, mega: 0, zoom: 0, scale: 1, sq: 0, lastHit: null });
    p.face = Math.atan2(-p.x, -p.z);
    p.g.root.visible = true; p.g.ring.visible = true;
  });
}

// ---------------- pickups ----------------
const PICK = {
  mega:  { color: 0xb26bff, geo: new THREE.BoxGeometry(0.55, 0.55, 0.55), label: 'MEGA' },
  zoom:  { color: 0x3ff0ff, geo: new THREE.OctahedronGeometry(0.42), label: 'ZOOM' },
  quake: { color: 0xff8a3d, geo: new THREE.TorusGeometry(0.3, 0.12, 10, 20), label: 'QUAKE' },
};
let pickups = [], pickTimer = 5;
function clearPickups() { for (const k of pickups) scene.remove(k.mesh); pickups = []; pickTimer = 5 + Math.random() * 2; }
function spawnPickup() {
  const okRing = Math.max(0, ...tiles.filter((t) => t.state === 'ok').map((t) => t.ring)) - 1;
  const cands = tiles.filter((t) => t.state === 'ok' && t.ring <= okRing && players.every((p) => !p.alive || Math.hypot(p.x - t.x, p.z - t.z) > 1.8));
  if (!cands.length) return;
  const t = cands[(Math.random() * cands.length) | 0];
  const types = Object.keys(PICK), type = types[(Math.random() * types.length) | 0];
  const mesh = new THREE.Mesh(PICK[type].geo, new THREE.MeshStandardMaterial({ color: PICK[type].color, emissive: PICK[type].color, emissiveIntensity: 0.6, roughness: 0.3 }));
  mesh.castShadow = true; mesh.position.set(t.x, 0.7, t.z); scene.add(mesh);
  pickups.push({ type, x: t.x, z: t.z, mesh, t: 0 });
}
function grab(p, k) {
  sfx.pickup(); burst(k.x, 0.7, k.z, PICK[k.type].color, 14, 5);
  feed(`<span style="color:${p.slot.css}">${p.slot.name}</span> got ${PICK[k.type].label}!`);
  if (k.type === 'mega') p.mega = 6;
  if (k.type === 'zoom') { p.zoom = 6; p.dashCd = 0; }
  if (k.type === 'quake') {
    sfx.quake(); shake = 0.6; shockwave(p.x, p.z, PICK.quake.color);
    for (const o of players) {
      if (o === p || !o.alive || o.falling) continue;
      const dx = o.x - p.x, dz = o.z - p.z, d = Math.hypot(dx, dz) || 0.01;
      if (d < 6) { const f = (6.5 - d) * 2.6 + 5; o.vx += dx / d * f / massOf(o); o.vz += dz / d * f / massOf(o); o.hitT = 0.5; o.lastHit = { by: p, t: clock }; o.sq = 1; }
    }
  }
}

// ---------------- HUD ----------------
function feed(html) {
  const d = document.createElement('div'); d.innerHTML = html; $('feed').appendChild(d);
  setTimeout(() => d.remove(), 3500);
}
let bigTimer = 0;
function big(text, color = '#fff', time = 1.2) {
  const b = $('big'); b.textContent = text; b.style.color = color; bigTimer = time;
  b.classList.add('pop'); setTimeout(() => b.classList.remove('pop'), 120);
}
function renderHud() {
  const top = Math.max(...players.map((p) => p.score));
  $('hud').innerHTML = players.map((p) => {
    let pips = ''; for (let i = 0; i < settings.target; i++) pips += `<span class="pip ${i < p.score ? 'f' : ''}"></span>`;
    return `<div class="pill ${p.alive ? '' : 'out'}" style="--c:${p.slot.css}"><span class="n">${top > 0 && p.score === top ? '👑 ' : ''}${p.slot.name}${p.cpu ? ' (CPU)' : ''}</span>${pips}</div>`;
  }).join('');
}

// ---------------- lobby ----------------
function renderLobby() {
  $('cards').innerHTML = SLOTS.map((s, i) => {
    const st = slotState[i], pad = padForSlot(i);
    const status = st === 'human' ? (pad ? '🎮 READY!' : 'READY!') : st === 'cpu' ? '🤖 CPU' : 'Press dash to join';
    return `<div class="card ${st !== 'empty' ? 'on' : ''}" style="--c:${s.css}" data-slot="${i}">
      <div class="blob"></div><div class="nm">${s.name}</div>
      <div class="keys">${s.hint}<br><span style="opacity:.7">or controller: press A</span></div>
      <div class="st">${status}</div>
      <button data-slot="${i}">${st === 'empty' ? 'Add CPU' : 'Remove'}</button></div>`;
  }).join('');
  document.querySelectorAll('[data-target]').forEach((b) => b.classList.toggle('sel', +b.dataset.target === settings.target));
  $('ctrlToggle').textContent = 'Controllers: ' + (settings.controllers ? 'ON' : 'OFF');
  $('startBtn').disabled = slotState.filter((s) => s !== 'empty').length < 2;
}
$('cards').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-slot]'); if (!b) return;
  const i = +b.dataset.slot;
  if (slotState[i] === 'empty') slotState[i] = 'cpu';
  else { slotState[i] = 'empty'; const pad = padForSlot(i); if (pad) pad.slot = -1; }
  renderLobby();
});
document.querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', () => { settings.target = +b.dataset.target; store.set('target', settings.target); renderLobby(); }));
$('ctrlToggle').addEventListener('click', () => {
  settings.controllers = !settings.controllers; store.set('controllers', settings.controllers);
  if (!settings.controllers) for (const st of pads.values()) if (st.slot >= 0) { slotState[st.slot] = 'empty'; st.slot = -1; }
  renderLobby();
});
$('startBtn').addEventListener('click', () => tryStart());
$('resumeBtn').addEventListener('click', () => setPaused(false));
$('quitBtn').addEventListener('click', () => toLobby());
$('rematchBtn').addEventListener('click', () => startMatch());
$('lobbyBtn').addEventListener('click', () => toLobby());

function lobbyInput() {
  SLOTS.forEach((s, i) => { if (anyPressed(s.keys.dash) && slotState[i] !== 'human') { slotState[i] = 'human'; sfx.beep(false); renderLobby(); } });
  for (const st of pads.values()) {
    if (st.slot < 0 && padPressed(st, 0)) {
      let i = slotState.findIndex((s, k) => s === 'empty' && !padForSlot(k));
      if (i < 0) i = slotState.findIndex((s, k) => s === 'cpu' && !padForSlot(k));
      if (i < 0) i = slotState.findIndex((s, k) => !padForSlot(k));
      if (i >= 0) { st.slot = i; slotState[i] = 'human'; sfx.beep(false); renderLobby(); }
    } else if (st.slot >= 0 && padPressed(st, 1)) { slotState[st.slot] = 'empty'; st.slot = -1; renderLobby(); }
  }
  if (pressed.has('Space') || anyPadPressed(9)) tryStart();
}
function tryStart() { if (slotState.filter((s) => s !== 'empty').length >= 2) startMatch(); }

// ---------------- game flow ----------------
let state = 'lobby', stateT = 0, roundTime = 0, endPending = -1, collapseT = 0, clock = 0, paused = false;
function show(id, on) { $(id).classList.toggle('hidden', !on); }
function toLobby() {
  state = 'lobby'; setPaused(false);
  show('lobby', true); show('end', false); show('hud', false); show('help', false); $('big').textContent = '';
  for (const p of players) { scene.remove(p.g.root); scene.remove(p.g.ring); }
  players = []; resetTiles(); clearPickups(); renderLobby();
}
function startMatch() {
  createPlayers();
  show('lobby', false); show('end', false); show('hud', true); show('help', true);
  startRound();
}
function startRound() {
  resetTiles(); clearPickups(); placePlayers();
  roundTime = 0; endPending = -1; collapseT = 8;
  state = 'countdown'; stateT = 3; lastBeep = 4;
  renderHud();
}
let lastBeep = 4;
function setPaused(v) {
  if (state !== 'play' && state !== 'countdown' && state !== 'roundEnd') v = false;
  paused = v; show('pause', v);
}
function eliminate(p) {
  p.alive = false; p.g.root.visible = false;
  const by = p.lastHit && clock - p.lastHit.t < 3.5 ? p.lastHit.by : null;
  if (by && by !== p) { by.kos++; feed(`<span style="color:${by.slot.css}">${by.slot.name}</span> bonked <span style="color:${p.slot.css}">${p.slot.name}</span> off!`); }
  else feed(`<span style="color:${p.slot.css}">${p.slot.name}</span> fell off!`);
  renderHud();
}
function finishRound() {
  const left = players.filter((p) => p.alive && !p.falling);
  const w = left.length === 1 ? left[0] : null;
  if (w) { w.score++; big(`${w.slot.name} WINS THE ROUND`, w.slot.css, 2.6); sfx.win(); }
  else big('NOBODY WINS!', '#fff', 2.6);
  state = 'roundEnd'; stateT = 2.6; renderHud();
}
function showMatchEnd() {
  const w = players.reduce((a, b) => (b.score > a.score ? b : a));
  state = 'end'; show('end', true); show('help', false); $('big').textContent = '';
  $('endTitle').textContent = `${w.slot.name} IS THE CHAMPION!`; $('endTitle').style.cssText = `font-size:clamp(36px,7vw,72px);color:${w.slot.css};background:none;-webkit-text-fill-color:${w.slot.css}`;
  $('endStats').innerHTML = players.map((p) => `<div style="--c:${p.slot.css}"><b>${p.slot.name}${p.cpu ? ' (CPU)' : ''}</b>${p.score} rounds · ${p.kos} bonk-offs</div>`).join('');
  sfx.win();
}

// ---------------- simulation ----------------
const massOf = (p) => (p.mega > 0 ? 2.6 : 1);
function botInput(p, dt) {
  const ai = p.ai;
  ai.think -= dt;
  if (ai.think <= 0) {
    ai.think = 0.12 + Math.random() * 0.12;
    let best = null, bd = 1e9;
    for (const o of players) { if (o === p || !o.alive || o.falling) continue; const d = Math.hypot(o.x - p.x, o.z - p.z); if (d < bd) { bd = d; best = o; } }
    let pk = null, pd = 1e9;
    for (const k of pickups) { const d = Math.hypot(k.x - p.x, k.z - p.z); if (d < pd) { pd = d; pk = k; } }
    if (pk && (!best || pd < bd * 0.7)) ai.goal = { x: pk.x, z: pk.z };
    else if (best) { // aim slightly on the centre side of the target so the hit pushes it outward
      const cx = centroid.x - best.x, cz = centroid.z - best.z, cl = Math.hypot(cx, cz) || 1;
      ai.goal = { x: best.x + cx / cl * 0.5, z: best.z + cz / cl * 0.5 };
    } else ai.goal = { ...centroid };
    ai.target = best; ai.dist = bd;
  }
  let dx = ai.goal.x - p.x, dz = ai.goal.z - p.z, l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
  const here = tileAt(p.x, p.z);
  if (!supported(p.x + p.vx * 0.4 + dx * 0.7, p.z + p.vz * 0.4 + dz * 0.7) || (here && here.state === 'warn') || Math.hypot(p.vx, p.vz) > 9) {
    dx = centroid.x - p.x; dz = centroid.z - p.z; l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    return { x: dx, y: dz, dash: false };
  }
  let dash = false;
  if (ai.target && ai.dist < 3.2 && p.dashCd <= 0 && Math.random() < dt * ai.aggr) {
    const tx = (ai.target.x - p.x) / ai.dist, tz = (ai.target.z - p.z) / ai.dist;
    if (supported(p.x + tx * 2.4, p.z + tz * 2.4)) { dash = true; dx = tx; dz = tz; }
  }
  return { x: dx, y: dz, dash };
}

function simulate(dt) {
  const canMove = state === 'play' || state === 'roundEnd';
  for (const p of players) {
    if (!p.alive) continue;
    p.dashCd -= dt; p.dashT -= dt; p.hitT -= dt; p.mega -= dt; p.zoom -= dt;
    p.sq *= Math.exp(-8 * dt);
    if (p.falling) {
      p.vy -= 32 * dt; p.y += p.vy * dt; p.x += p.vx * dt; p.z += p.vz * dt;
      if (p.y < -14) eliminate(p);
      continue;
    }
    const inp = canMove ? (p.cpu ? botInput(p, dt) : slotInput(p.i)) : { x: 0, y: 0, dash: false };
    const spd = p.zoom > 0 ? 1.45 : 1, acc = 24 * spd / (p.mega > 0 ? 1.2 : 1);
    p.vx += inp.x * acc * dt; p.vz += inp.y * acc * dt;
    if (inp.dash && p.dashCd <= 0) {
      let dx = inp.x, dz = inp.y, l = Math.hypot(dx, dz);
      if (l < 0.2) { dx = Math.sin(p.face); dz = Math.cos(p.face); l = 1; }
      p.vx += dx / l * 14 * spd; p.vz += dz / l * 14 * spd;
      p.dashCd = p.zoom > 0 ? 0.45 : 0.95; p.dashT = 0.24; p.sq = 0.8;
      sfx.dash(); burst(p.x, 0.2, p.z, 0xffffff, 6, 2.5);
    }
    const fr = Math.exp(-(p.dashT > 0 ? 1.1 : 3.2) * dt); p.vx *= fr; p.vz *= fr;
    p.x += p.vx * dt; p.z += p.vz * dt;
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > 0.6) { let d = Math.atan2(p.vx, p.vz) - p.face; d = Math.atan2(Math.sin(d), Math.cos(d)); p.face += d * Math.min(1, 12 * dt); }
    const target = p.mega > 0 ? 1.6 : 1; p.scale += (target - p.scale) * Math.min(1, 8 * dt);
    if (!supported(p.x, p.z)) { p.falling = true; p.vy = 2; sfx.fall(); p.g.ring.visible = false; }
  }
  // blob vs blob
  for (let a = 0; a < players.length; a++) for (let b = a + 1; b < players.length; b++) {
    const A = players[a], B = players[b];
    if (!A.alive || !B.alive || A.falling || B.falling) continue;
    const dx = B.x - A.x, dz = B.z - A.z, d = Math.hypot(dx, dz), rr = 0.55 * (A.scale + B.scale);
    if (d >= rr || d < 1e-5) continue;
    const nx = dx / d, nz = dz / d, ma = massOf(A), mb = massOf(B), ov = rr - d;
    A.x -= nx * ov * mb / (ma + mb); A.z -= nz * ov * mb / (ma + mb);
    B.x += nx * ov * ma / (ma + mb); B.z += nz * ov * ma / (ma + mb);
    const rv = (B.vx - A.vx) * nx + (B.vz - A.vz) * nz;
    if (rv >= 0) continue;
    const j = -2 * rv / (1 / ma + 1 / mb);
    A.vx -= j / ma * nx; A.vz -= j / ma * nz; B.vx += j / mb * nx; B.vz += j / mb * nz;
    const bonusB = A.dashT > 0 ? 7 * Math.sqrt(ma / mb) : 0, bonusA = B.dashT > 0 ? 7 * Math.sqrt(mb / ma) : 0;
    B.vx += nx * bonusB; B.vz += nz * bonusB; A.vx -= nx * bonusA; A.vz -= nz * bonusA;
    const str = -rv + bonusA + bonusB;
    A.lastHit = { by: B, t: clock }; B.lastHit = { by: A, t: clock };
    A.hitT = B.hitT = 0.3; A.sq = B.sq = Math.min(1, str / 10);
    sfx.bonk(str);
    const cx = A.x + nx * 0.55 * A.scale, cz = A.z + nz * 0.55 * A.scale;
    burst(cx, 0.6, cz, A.slot.color, 5 + (str | 0) / 2, 3 + str * 0.25); burst(cx, 0.6, cz, B.slot.color, 5 + (str | 0) / 2, 3 + str * 0.25);
    if (str > 12) shake = Math.max(shake, Math.min(0.5, str * 0.025));
  }
  // pickups
  for (const k of [...pickups]) {
    k.t += dt;
    const t = tileAt(k.x, k.z);
    let take = null;
    for (const p of players) if (p.alive && !p.falling && Math.hypot(p.x - k.x, p.z - k.z) < 0.55 * p.scale + 0.4) { take = p; break; }
    if (take || k.t > 12 || !t || t.state !== 'ok') { scene.remove(k.mesh); pickups.splice(pickups.indexOf(k), 1); if (take) grab(take, k); }
  }
}

function updateTiles(dt) {
  if (state === 'play') {
    const okCount = updateCentroid();
    collapseT -= dt;
    const floor = roundTime > 75 ? 1 : 7;
    if (collapseT <= 0 && okCount > floor) {
      collapseT = Math.max(0.4, 1.5 - (roundTime - 8) * 0.025);
      const ok = tiles.filter((t) => t.state === 'ok');
      const maxRing = Math.max(...ok.map((t) => t.ring));
      const pool = Math.random() < 0.75 ? ok.filter((t) => t.ring === maxRing) : ok.filter((t) => t.ring > 0);
      const t = (pool.length ? pool : ok)[(Math.random() * (pool.length || ok.length)) | 0];
      t.state = 'warn'; t.t = 1.3;
    }
    if (roundTime > 75 && roundTime - dt <= 75) big('SUDDEN DEATH', '#ff8a3d', 1.6);
  } else updateCentroid();
  for (const t of tiles) {
    if (t.state === 'warn') {
      t.t -= dt;
      const flash = (Math.sin(t.t * 30) + 1) / 2;
      t.top.color.copy(t.base).lerp(new THREE.Color(0xff3b3b), 0.4 + flash * 0.5);
      t.mesh.position.set(t.x + (Math.random() - 0.5) * 0.08, 0, t.z + (Math.random() - 0.5) * 0.08);
      if (t.t <= 0) {
        t.state = 'gone'; t.vy = 0; t.spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(3);
        sfx.crumble(); burst(t.x, -0.2, t.z, 0x7a5640, 8, 3);
      }
    } else if (t.state === 'gone' && t.mesh.visible) {
      t.vy -= 22 * dt; t.mesh.position.y += t.vy * dt;
      t.mesh.rotation.x += t.spin.x * dt; t.mesh.rotation.z += t.spin.z * dt;
      if (t.mesh.position.y < -40) t.mesh.visible = false;
    }
  }
}

function render(dt, time) {
  const top = players.length ? Math.max(...players.map((p) => p.score)) : 0;
  for (const p of players) {
    const g = p.g;
    if (!p.alive) { g.ring.visible = false; continue; }
    const sp = Math.hypot(p.vx, p.vz), hop = p.falling ? 0 : Math.abs(Math.sin(time * 14)) * Math.min(0.12, sp * 0.02);
    g.root.position.set(p.x, p.y + hop, p.z); g.root.rotation.y = p.face; g.root.scale.setScalar(p.scale);
    if (p.falling) g.root.rotation.x += dt * 6;
    else g.root.rotation.x = 0;
    g.squash.scale.set(1 + p.sq * 0.3, 1 - p.sq * 0.32, 1 + p.sq * 0.3);
    g.mat.emissiveIntensity = p.zoom > 0 ? 0.35 + Math.sin(time * 18) * 0.25 : p.mega > 0 ? 0.25 : 0;
    g.crown.visible = top > 0 && p.score === top;
    g.ring.position.set(p.x, 0.03, p.z); g.ring.scale.setScalar(p.scale);
    g.ring.material.opacity = p.dashCd > 0 ? 0.25 : 0.9;
  }
  for (const k of pickups) { k.mesh.rotation.y += dt * 2.5; k.mesh.rotation.x += dt * 1.2; k.mesh.position.y = 0.75 + Math.sin(time * 3 + k.x) * 0.15; k.mesh.visible = !(k.t > 9 && Math.sin(time * 20) > 0); }
  for (const m of [...parts]) {
    const u = m.userData; u.life -= dt; u.v.y -= 14 * dt; m.position.addScaledVector(u.v, dt); m.scale.multiplyScalar(Math.exp(-2 * dt));
    if (u.life <= 0) { scene.remove(m); parts.splice(parts.indexOf(m), 1); partPool.push(m); }
  }
  for (const w of [...waves]) {
    w.t += dt; w.m.scale.setScalar(1 + w.t * 14); w.m.material.opacity = Math.max(0, 1 - w.t * 2.2);
    if (w.t > 0.5) { scene.remove(w.m); w.m.geometry.dispose(); w.m.material.dispose(); waves.splice(waves.indexOf(w), 1); }
  }
  for (const r of rocks) { const u = r.userData; u.a += u.s * dt; r.position.set(Math.cos(u.a) * u.r, u.y + Math.sin(time + u.r) * 0.6, Math.sin(u.a) * u.r); r.rotation.y += dt * 0.2; }
  shake *= Math.exp(-6 * dt);
  const drift = state === 'lobby' ? new THREE.Vector3(Math.sin(time * 0.15) * 6, 0, Math.cos(time * 0.15) * 4 - 2) : new THREE.Vector3();
  camera.position.copy(camBase).add(drift).add(new THREE.Vector3((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, 0));
  camera.lookAt(0, 0, 0.8);
  renderer.render(scene, camera);
}

// ---------------- main loop ----------------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  pollPads();
  const escape = pressed.has('Escape') || anyPadPressed(9);
  if (state === 'lobby') lobbyInput();
  else if (state === 'end') {
    if (pressed.has('Space') || anyPadPressed(0, 9)) startMatch();
    else if (pressed.has('Escape') || anyPadPressed(1)) toLobby();
  } else if (paused) {
    if (escape) setPaused(false);
    else if (pressed.has('Backspace') || anyPadPressed(8)) toLobby();
  } else if (escape) setPaused(true);

  if (!paused && state !== 'lobby' && state !== 'end') {
    clock += dt;
    if (state === 'countdown') {
      stateT -= dt;
      const n = Math.ceil(stateT);
      if (n !== lastBeep && n > 0) { lastBeep = n; big(String(n), '#fff', 1); sfx.beep(false); }
      if (stateT <= 0) { state = 'play'; big('BONK!', '#ffc62e', 0.8); sfx.beep(true); }
    } else if (state === 'play') {
      roundTime += dt;
      pickTimer -= dt;
      if (pickTimer <= 0) { pickTimer = 5 + Math.random() * 3; if (pickups.length < 2) spawnPickup(); }
      if (endPending < 0 && players.filter((p) => p.alive && !p.falling).length <= 1) endPending = 1.0;
      if (endPending >= 0) { endPending -= dt; if (endPending < 0) finishRound(); }
    } else if (state === 'roundEnd') {
      stateT -= dt;
      if (stateT <= 0) { if (players.some((p) => p.score >= settings.target)) showMatchEnd(); else startRound(); }
    }
    simulate(dt);
    updateTiles(dt);
  }
  if (bigTimer > 0) { bigTimer -= dt; if (bigTimer <= 0) $('big').textContent = ''; }
  render(paused ? 0 : dt, now / 1000);
  pressed.clear();
  requestAnimationFrame(frame);
}
renderLobby();
requestAnimationFrame(frame);
if (location.search.includes('test')) window.__bb = { info: () => ({ state, roundTime: +roundTime.toFixed(1), gone: tiles.filter((t) => t.state === 'gone').length, scores: players.map((p) => p.score), alive: players.map((p) => p.alive) }) };
