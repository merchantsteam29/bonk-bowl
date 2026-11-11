// BONK BOWL: 3-player local sumo on one device.
import * as THREE from 'three';
import { createGovernor } from './perf.js';
import { Room } from './net.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('bonkbowl.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bonkbowl.' + k, JSON.stringify(v)); } catch {} },
};
// lifetime stats (for achievements and the Game Library profile)
const stats = { matches: 0, wins: 0, bonkoffs: 0, online: 0, ...store.get('stats', {}) };
const saveStats = () => store.set('stats', stats);
const settings = { controllers: store.get('controllers', true), target: store.get('target', 5), map: store.get('map', 'meadow'), cpu: store.get('cpu', 'easy'),
  vol: store.get('vol', 0.8), shake: store.get('shake', 1), autoRes: store.get('autoRes', true) };
// CPU difficulty: how often they rethink, how keen they are to dash, dash range, how hard they push the stick
const CPU = {
  easy:   { label: 'Easy',   think: 0.4,  aggr: 0.8, range: 2.4, push: 0.7 },
  normal: { label: 'Normal', think: 0.2,  aggr: 1.8, range: 3.0, push: 0.85 },
  hard:   { label: 'Hard',   think: 0.1,  aggr: 3.4, range: 3.6, push: 1 },
};
if (!CPU[settings.cpu]) settings.cpu = 'easy';

const SLOTS = [
  { name: 'RED',  color: 0xff4d5e, css: '#ff4d5e', hint: 'Move W A S D<br>Dash Q',
    keys: { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], dash: ['KeyQ'] } },
  { name: 'BLUE', color: 0x3fa9ff, css: '#3fa9ff', hint: 'Move I J K L<br>Dash U',
    keys: { up: ['KeyI'], down: ['KeyK'], left: ['KeyJ'], right: ['KeyL'], dash: ['KeyU'] } },
  { name: 'GOLD', color: 0xffc62e, css: '#ffc62e', hint: 'Move Arrow keys<br>Dash Enter / Numpad 0',
    keys: { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], dash: ['Enter', 'NumpadEnter', 'Numpad0', 'Slash'] } },
];
const slotState = ['empty', 'empty', 'empty']; // empty | human | cpu | net (a friend online)
// ---------------- online (net.js) ----------------
// NET.hosting: this browser runs the match for friends. NET.client: this browser mirrors a friend's match.
const NET = { room: null, hosting: false, client: false, ev: [], snapT: 0, peerSlot: new Map(), names: ['', '', ''], input: [null, null, null], mySlot: -1, snap: null, sendT: 0, dashQ: false };
const emit = (...e) => { if (NET.hosting) NET.ev.push(e); };

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
addEventListener('blur', () => { held.clear(); if (typeof setPaused === 'function' && (state === 'play' || state === 'countdown')) setPaused(true); });
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
  if (slotState[i] === 'net') { const n = NET.input[i] || { x: 0, y: 0, dash: false }; const d = n.dash; n.dash = false; return { x: n.x, y: n.y, dash: d }; }
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

function clientInput() {
  let x = 0, y = 0;
  for (const s of SLOTS) { const k = s.keys; if (anyHeld(k.left)) x -= 1; if (anyHeld(k.right)) x += 1; if (anyHeld(k.up)) y -= 1; if (anyHeld(k.down)) y += 1; }
  let dash = SLOTS.some((s) => anyPressed(s.keys.dash)) || pressed.has('Space');
  for (const st of pads.values()) { x += st.move.x; y += st.move.y; if (padPressed(st, 0) || padPressed(st, 2) || padPressed(st, 5) || padPressed(st, 7)) dash = true; }
  const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
  return { x, y, dash };
}

// ---------------- audio ----------------
let ac = null, master = null;
function audio() {
  if (!ac) {
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); master = ac.createGain(); master.gain.value = 0.6 * settings.vol; master.connect(ac.destination); }
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
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
// perf.js trims the render resolution a little when frames run slow (and gives it back when they don't)
const gov = createGovernor({ apply: (s) => renderer.setPixelRatio(Math.min(devicePixelRatio, 2) * s) });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1d1840);
scene.fog = new THREE.Fog(0x1d1840, 34, 80);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
const camBase = new THREE.Vector3(0, 19, 15.5);
let mapScale = 1; // bigger maps pull the camera back
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  const far = (camera.aspect < 1.2 ? 1.2 / camera.aspect : 1) * mapScale; // portrait / narrow screens pull back
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

// ---------------- maps ----------------
const S = 1.15, SQ3 = Math.sqrt(3);
const HEX_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const hexDist = (q, r) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
const hexToWorld = (q, r) => ({ x: S * SQ3 * (q + r / 2), z: S * 1.5 * r });
function hexArea(cq, cr, rad, into) {
  for (let q = -rad; q <= rad; q++) for (let r = -rad; r <= rad; r++) if (hexDist(q, r) <= rad) into.add((cq + q) + ',' + (cr + r));
  return into;
}
const ISLE_DIRS = [[1, -1], [-1, 0], [0, 1]];
const MAPS = {
  meadow: { name: 'Meadow Bowl', desc: 'The classic. One big round field.', bg: 0x1d1840, side: 0x7a5640, tops: [0x84dca8, 0x9be8b8, 0xc6f5d2],
    cells: () => hexArea(0, 0, 4, new Set()) },
  donut: { name: 'Donut Dunes', desc: 'A ring of sand with a hole in the middle.', bg: 0x2a1530, side: 0x9a6a3a, tops: [0xf0c987, 0xf7d9a0, 0xf7d9a0],
    cells: () => { const s = hexArea(0, 0, 5, new Set()); for (const k of hexArea(0, 0, 1, new Set())) s.delete(k); return s; }, spawnR: 6.6 },
  isles: { name: 'Three Isles', desc: 'Everyone starts on their own island. Bridges meet in the middle.', bg: 0x14243a, side: 0x6b5a48, tops: [0xe8a35a, 0xf2bd78, 0xffe0a8],
    cells: () => { const s = hexArea(0, 0, 1, new Set()); for (const [dq, dr] of ISLE_DIRS) { hexArea(dq * 5, dr * 5, 2, s); s.add(dq * 2 + ',' + dr * 2); } return s; },
    spawns: () => ISLE_DIRS.map(([dq, dr]) => hexToWorld(dq * 5, dr * 5)) },
  bumper: { name: 'Bumper Park', desc: 'Bouncy posts fling you across the field.', bg: 0x2b1438, side: 0x8a4a78, tops: [0xff9ccf, 0xffb8dc, 0xffe0f0],
    cells: () => hexArea(0, 0, 4, new Set()), bumpers: [[2, 0], [-2, 0], [0, 2], [0, -2], [2, -2], [-2, 2]] },
  ice: { name: 'Frozen Pond', desc: 'Slippery ice. Hard to stop!', bg: 0x101c33, side: 0x7d9ab8, tops: [0xbfe6ff, 0xd8f1ff, 0xf0faff], ice: true,
    cells: () => hexArea(0, 0, 4, new Set()) },
  carousel: { name: 'Carousel', desc: 'The whole bowl turns. Stand still and it carries you to the edge.', bg: 0x1f1030, side: 0xb0603a, tops: [0xffb35a, 0xff7a8a, 0xfff0b0], spin: 0.32,
    cells: () => { const s = hexArea(0, 0, 4, new Set()); for (const k of ['3,1', '-3,-1', '1,-4', '-1,4']) s.delete(k); return s; } },
  factory: { name: 'Factory Floor', desc: 'Conveyor belts push you sideways. Use them to ram, or fight them.', bg: 0x14181f, side: 0x5a6068, tops: [0x9aa4b0, 0xb8c0ca, 0xd6dce2],
    cells: () => hexArea(0, 0, 4, new Set()),
    // rows of belts, alternating direction
    belt: (q, r) => (r === -2 ? -1 : r === 0 ? 1 : r === 2 ? -1 : 0) },
};
const MAP_IDS = Object.keys(MAPS);
let MAP = MAPS.meadow, mapId = 'meadow';
const tiles = [], tileMap = new Map(), bumpers = [];
const sideMat = new THREE.MeshStandardMaterial({ color: 0x7a5640, roughness: 0.95, flatShading: true });
const botMat = new THREE.MeshStandardMaterial({ color: 0x3f2c26, roughness: 1, flatShading: true });
const tileGeo = new THREE.CylinderGeometry(S * 0.965, S * 0.7, 1.1, 6, 1);
tileGeo.translate(0, -0.55, 0);
const bumperGeo = new THREE.CylinderGeometry(0.45, 0.52, 0.8, 24); bumperGeo.translate(0, 0.4, 0);
const bumperMat = new THREE.MeshStandardMaterial({ color: 0xff3d9a, emissive: 0xff3d9a, emissiveIntensity: 0.35, roughness: 0.3 });
const bumperCapGeo = new THREE.SphereGeometry(0.42, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2); bumperCapGeo.translate(0, 0.8, 0);
const bumperCapMat = new THREE.MeshStandardMaterial({ color: 0xfff0f8, roughness: 0.25 });
function buildArena(id) {
  mapId = id; MAP = MAPS[id];
  for (const t of tiles) { scene.remove(t.mesh); t.top.dispose(); }
  tiles.length = 0; tileMap.clear(); bumpers.length = 0;
  sideMat.color.setHex(MAP.side);
  scene.background.setHex(MAP.bg); scene.fog.color.setHex(MAP.bg);
  const bset = new Set((MAP.bumpers || []).map(([q, r]) => q + ',' + r));
  let ext = 0;
  for (const key of MAP.cells()) {
    const [q, r] = key.split(',').map(Number), ring = hexDist(q, r), { x, z } = hexToWorld(q, r);
    const base = new THREE.Color(MAP.tops[ring === 0 ? 2 : ring % 2]);
    const top = new THREE.MeshStandardMaterial({ color: base.clone(), roughness: MAP.ice ? 0.12 : 0.8, metalness: MAP.ice ? 0.15 : 0, flatShading: true });
    const mesh = new THREE.Mesh(tileGeo, [sideMat, top, botMat]);
    mesh.position.set(x, 0, z); mesh.receiveShadow = true; mesh.castShadow = true;
    scene.add(mesh);
    const t = { q, r, ring, x, z, ax: x, az: z, mesh, top, base, state: 'ok', t: 0, vy: 0, spin: new THREE.Vector3(), bumper: null, bump: 0, belt: MAP.belt ? MAP.belt(q, r) : 0 };
    if (t.belt) { base.lerp(new THREE.Color(0x3a4048), 0.55); top.color.copy(base); }
    if (bset.has(key)) {
      const b = new THREE.Group(), post = new THREE.Mesh(bumperGeo, bumperMat), cap = new THREE.Mesh(bumperCapGeo, bumperCapMat);
      post.castShadow = true; b.add(post, cap); mesh.add(b); t.bumper = b; bumpers.push(t);
    }
    tiles.push(t); tileMap.set(key, t);
    ext = Math.max(ext, Math.hypot(x, z) + S);
  }
  spinA = 0;
  mapScale = Math.max(1, ext / 9.2);
  Object.assign(sun.shadow.camera, { left: -ext - 2, right: ext + 2, top: ext + 2, bottom: -ext - 2 });
  sun.shadow.camera.updateProjectionMatrix();
  resize();
}
let spinA = 0; // how far the Carousel has turned
function tileAt(x, z) {
  if (spinA) { const c = Math.cos(-spinA), sn = Math.sin(-spinA), x2 = x * c - z * sn; z = x * sn + z * c; x = x2; }
  const fq = (SQ3 / 3 * x - z / 3) / S, fr = (2 / 3 * z) / S, fs = -fq - fr;
  let rq = Math.round(fq), rr = Math.round(fr); const rs = Math.round(fs);
  const dq = Math.abs(rq - fq), dr = Math.abs(rr - fr), ds = Math.abs(rs - fs);
  if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs;
  return tileMap.get(rq + ',' + rr) || null;
}
const solid = (x, z) => { const t = tileAt(x, z); return !!t && t.state !== 'gone'; };
// A small lip: you only fall once your middle is clearly past the edge.
const LIP = 0.34;
function supported(x, z) {
  if (solid(x, z)) return true;
  for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; if (solid(x + Math.cos(a) * LIP, z + Math.sin(a) * LIP)) return true; }
  return false;
}
function resetTiles() {
  spinA = 0;
  for (const t of tiles) { t.x = t.ax; t.z = t.az;
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
// Nearby tile with lots of solid neighbours: where bots run to when in danger.
function safeSpot(p) {
  let best = null, bs = 1e9;
  for (const t of tiles) {
    if (t.state !== 'ok' || t.bumper) continue;
    let nb = 0;
    for (const [dq, dr] of HEX_DIRS) { const n = tileMap.get((t.q + dq) + ',' + (t.r + dr)); if (n && n.state === 'ok') nb++; }
    const s = Math.hypot(t.x - p.x, t.z - p.z) - nb * 0.8;
    if (s < bs) { bs = s; best = t; }
  }
  return best ? { x: best.x, z: best.z } : { ...centroid };
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
    players.push({ i, slot: s, cpu: slotState[i] === 'cpu', net: slotState[i] === 'net', g: makeBlob(s.color), score: 0, kos: 0,
      ai: { think: 0, goal: { x: 0, z: 0 }, safe: { x: 0, z: 0 }, target: null, dist: 99, aggr: 0.8 + Math.random() * 0.4 } });
  });
}
function placePlayers() {
  const n = players.length, spots = MAP.spawns ? MAP.spawns() : null, R = MAP.spawnR || 3.6;
  players.forEach((p, k) => {
    const a = Math.PI / 2 + (k / n) * Math.PI * 2;
    const at = spots ? spots[k % spots.length] : { x: Math.cos(a) * R, z: Math.sin(a) * R };
    Object.assign(p, { x: at.x, z: at.z, y: 0, vx: 0, vz: 0, vy: 0, alive: true, falling: false,
      dashCd: 0, dashT: 0, hitT: 0, mega: 0, zoom: 0, magnet: 0, slip: 0, scale: 1, sq: 0, lastHit: null });
    p.face = Math.atan2(-p.x, -p.z);
    p.g.root.visible = true; p.g.ring.visible = true;
  });
}

// ---------------- pickups ----------------
const PICK = {
  mega:  { color: 0xb26bff, geo: new THREE.BoxGeometry(0.55, 0.55, 0.55), label: 'MEGA' },
  zoom:  { color: 0x3ff0ff, geo: new THREE.OctahedronGeometry(0.42), label: 'ZOOM' },
  quake: { color: 0xff8a3d, geo: new THREE.TorusGeometry(0.3, 0.12, 10, 20), label: 'QUAKE' },
  magnet: { color: 0xff3b5c, geo: new THREE.TorusGeometry(0.3, 0.11, 10, 20, Math.PI * 1.2), label: 'MAGNET' },
  banana: { color: 0xffe14a, geo: new THREE.CapsuleGeometry(0.12, 0.42, 4, 10), label: 'BANANA' },
};
// banana peels on the floor: { x, z, owner, t, mesh }
let peels = [];
const peelGeo = new THREE.TorusGeometry(0.2, 0.07, 6, 12, Math.PI * 1.4), peelMat = new THREE.MeshStandardMaterial({ color: 0xffd23a, roughness: 0.5 });
function dropPeel(x, z, owner) {
  const mesh = new THREE.Mesh(peelGeo, peelMat); mesh.rotation.x = -Math.PI / 2; mesh.position.set(x, 0.62, z); scene.add(mesh);
  peels.push({ x, z, owner, t: 0, mesh });
}
function clearPeels() { for (const b of peels) scene.remove(b.mesh); peels = []; }
let pickups = [], pickTimer = 5;
function clearPickups() { for (const k of pickups) scene.remove(k.mesh); pickups = []; pickTimer = 5 + Math.random() * 2; }
function spawnPickup() {
  const okRing = Math.max(0, ...tiles.filter((t) => t.state === 'ok').map((t) => t.ring)) - 1;
  const cands = tiles.filter((t) => t.state === 'ok' && !t.bumper && t.ring <= okRing && players.every((p) => !p.alive || Math.hypot(p.x - t.x, p.z - t.z) > 1.8));
  if (!cands.length) return;
  const t = cands[(Math.random() * cands.length) | 0];
  const types = Object.keys(PICK), type = types[(Math.random() * types.length) | 0];
  const mesh = new THREE.Mesh(PICK[type].geo, new THREE.MeshStandardMaterial({ color: PICK[type].color, emissive: PICK[type].color, emissiveIntensity: 0.6, roughness: 0.3 }));
  mesh.castShadow = true; mesh.position.set(t.x, 0.7, t.z); scene.add(mesh);
  pickups.push({ type, x: t.x, z: t.z, mesh, t: 0 });
}
function grab(p, k) {
  sfx.pickup(); burst(k.x, 0.7, k.z, PICK[k.type].color, 14, 5); emit('grab', k.type, +k.x.toFixed(2), +k.z.toFixed(2), p.i);
  feed(`<span style="color:${p.slot.css}">${p.slot.name}</span> got ${PICK[k.type].label}!`);
  if (k.type === 'mega') p.mega = 6;
  if (k.type === 'magnet') p.magnet = 5;
  if (k.type === 'banana') { const bx = p.x - Math.sin(p.face) * 1.3, bz = p.z - Math.cos(p.face) * 1.3; dropPeel(solid(bx, bz) ? bx : p.x, solid(bx, bz) ? bz : p.z, p); }
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
  emit('feed', html);
  const d = document.createElement('div'); d.innerHTML = html; $('feed').appendChild(d);
  setTimeout(() => d.remove(), 3500);
}
let bigTimer = 0;
function big(text, color = '#fff', time = 1.2) {
  emit('big', text, color, time);
  const b = $('big'); b.textContent = text; b.style.color = color; bigTimer = time;
  b.classList.add('pop'); setTimeout(() => b.classList.remove('pop'), 120);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const who = (p) => p.cpu ? p.slot.name + ' (CPU)' : (p.net || NET.client) && NET.names[p.i] ? esc(NET.names[p.i]) : p.slot.name;
function renderHud() {
  const top = Math.max(...players.map((p) => p.score));
  $('hud').innerHTML = players.map((p) => {
    let pips = ''; for (let i = 0; i < settings.target; i++) pips += `<span class="pip ${i < p.score ? 'f' : ''}"></span>`;
    return `<div class="pill ${p.alive ? '' : 'out'}" style="--c:${p.slot.css}"><span class="n">${top > 0 && p.score === top ? '👑 ' : ''}${who(p)}</span>${pips}</div>`;
  }).join('');
}

// ---------------- lobby ----------------
function renderLobby() {
  $('cards').innerHTML = SLOTS.map((s, i) => {
    const st = slotState[i], pad = padForSlot(i);
    const status = st === 'net' ? '🌐 ' + esc(NET.names[i] || 'Friend') + (NET.client && NET.mySlot === i ? ' (you)' : '') : st === 'human' ? (pad ? '🎮 READY!' : 'READY!') : st === 'cpu' ? '🤖 CPU' : NET.client ? 'Empty' : 'Press dash to join';
    return `<div class="card ${st !== 'empty' ? 'on' : ''}" style="--c:${s.css}" data-slot="${i}">
      <div class="blob"></div><div class="nm">${s.name}</div>
      <div class="keys">${s.hint}<br><span style="opacity:.7">or controller: press A</span></div>
      <div class="st">${status}</div>
      ${NET.client ? '' : `<button data-slot="${i}">${st === 'empty' ? 'Add CPU' : st === 'net' ? 'Kick' : 'Remove'}</button>`}</div>`;
  }).join('');
  document.querySelectorAll('[data-target]').forEach((b) => b.classList.toggle('sel', +b.dataset.target === settings.target));
  $('ctrlToggle').textContent = 'Controllers: ' + (settings.controllers ? 'ON' : 'OFF');
  $('maps').innerHTML = [...MAP_IDS, 'random'].map((id) => `<button data-map="${id}" class="${settings.map === id ? 'sel' : ''}">${id === 'random' ? '🎲 Random' : MAPS[id].name}</button>`).join('');
  $('mapDesc').textContent = settings.map === 'random' ? 'A different map every round.' : MAPS[settings.map].desc;
  $('cpuLevel').innerHTML = Object.keys(CPU).map((id) => `<button data-cpu="${id}" class="${settings.cpu === id ? 'sel' : ''}">${CPU[id].label}</button>`).join('');
  $('startBtn').disabled = NET.client || slotState.filter((s) => s !== 'empty').length < 2;
  $('startBtn').innerHTML = NET.client ? 'Waiting for the host to start…' : 'START &nbsp;(Space)';
  netStatus();
  if (NET.hosting) NET.room.broadcast({ t: 'lobby', slots: slotState, names: NET.names, map: settings.map === 'random' ? 'random' : settings.map, target: settings.target, cpu: settings.cpu });
}
$('cards').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-slot]'); if (!b) return;
  const i = +b.dataset.slot;
  if (NET.client) return;
  if (slotState[i] === 'net') { for (const [id, s] of NET.peerSlot) if (s === i) { NET.room.send(id, { t: 'kicked' }); setTimeout(() => NET.room.kick(id), 200); NET.peerSlot.delete(id); } slotState[i] = 'empty'; NET.names[i] = ''; }
  else if (slotState[i] === 'empty') slotState[i] = 'cpu';
  else { slotState[i] = 'empty'; const pad = padForSlot(i); if (pad) pad.slot = -1; }
  renderLobby();
});
document.querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', () => { settings.target = +b.dataset.target; store.set('target', settings.target); renderLobby(); }));
$('ctrlToggle').addEventListener('click', () => {
  settings.controllers = !settings.controllers; store.set('controllers', settings.controllers);
  if (!settings.controllers) for (const st of pads.values()) if (st.slot >= 0) { slotState[st.slot] = 'empty'; st.slot = -1; }
  renderLobby();
});
$('maps').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-map]'); if (!b) return;
  settings.map = b.dataset.map; store.set('map', settings.map);
  if (settings.map !== 'random') buildArena(settings.map);
  renderLobby();
});
$('cpuLevel').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cpu]'); if (!b) return;
  settings.cpu = b.dataset.cpu; store.set('cpu', settings.cpu); renderLobby();
});
$('startBtn').addEventListener('click', () => tryStart());
// ---- settings panel (lobby and pause) ----
let setOpen = false, setFrom = 'lobby';
function syncSettings() {
  $('sVol').value = settings.vol; $('oVol').textContent = Math.round(settings.vol * 100) + '%';
  $('shakeSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('sel', +b.dataset.v === settings.shake));
  $('autoResBtn').textContent = settings.autoRes ? 'ON' : 'OFF'; $('autoResBtn').classList.toggle('sel', settings.autoRes);
  $('fsBtn').textContent = document.fullscreenElement ? 'Leave fullscreen' : 'Fullscreen';
  if (master) master.gain.value = 0.6 * settings.vol;
  store.set('vol', settings.vol); store.set('shake', settings.shake); store.set('autoRes', settings.autoRes);
}
function openSettings() { setFrom = paused ? 'pause' : 'lobby'; show(setFrom, false); show('setPanel', true); setOpen = true; syncSettings(); }
function closeSettings() { show('setPanel', false); show(setFrom, true); setOpen = false; }
$('setBtn').addEventListener('click', openSettings);
$('pSetBtn').addEventListener('click', openSettings);
$('setDone').addEventListener('click', closeSettings);
$('sVol').addEventListener('input', () => { settings.vol = +$('sVol').value; syncSettings(); });
$('sVol').addEventListener('change', () => { if (audio()) sfx.beep(false); });
$('shakeSeg').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) { settings.shake = +b.dataset.v; syncSettings(); } });
$('autoResBtn').addEventListener('click', () => { settings.autoRes = !settings.autoRes; if (!settings.autoRes) gov.reset(); syncSettings(); });
$('fsBtn').addEventListener('click', () => { const r = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); r?.catch?.(() => {}); });
document.addEventListener('fullscreenchange', () => { if (setOpen) syncSettings(); });
if (!document.documentElement.requestFullscreen) $('fsBtn').classList.add('hidden');
document.addEventListener('visibilitychange', () => { if (!ac) return; if (document.hidden) ac.suspend().catch(() => {}); else ac.resume().catch(() => {}); });
$('resumeBtn').addEventListener('click', () => setPaused(false));
$('quitBtn').addEventListener('click', () => toLobby());
$('rematchBtn').addEventListener('click', () => startMatch());
$('lobbyBtn').addEventListener('click', () => { if (NET.client) leaveOnline(); else toLobby(); });

function lobbyInput() {
  if (NET.client) return;
  SLOTS.forEach((s, i) => { if (anyPressed(s.keys.dash) && slotState[i] !== 'human' && slotState[i] !== 'net') { slotState[i] = 'human'; sfx.beep(false); renderLobby(); } });
  for (const st of pads.values()) {
    if (st.slot < 0 && padPressed(st, 0)) {
      let i = slotState.findIndex((s, k) => s === 'empty' && !padForSlot(k));
      if (i < 0) i = slotState.findIndex((s, k) => s === 'cpu' && !padForSlot(k));
      if (i < 0) i = slotState.findIndex((s, k) => s !== 'net' && !padForSlot(k));
      if (i >= 0) { st.slot = i; slotState[i] = 'human'; sfx.beep(false); renderLobby(); }
    } else if (st.slot >= 0 && padPressed(st, 1)) { slotState[st.slot] = 'empty'; st.slot = -1; renderLobby(); }
  }
  if (pressed.has('Space') || anyPadPressed(9)) tryStart();
}
function tryStart() { if (slotState.filter((s) => s !== 'empty').length >= 2) startMatch(); }

// ---------------- game flow ----------------
let hitStop = 0, slowT = 0; // game feel: freeze on big bonks, slow motion when the round is decided
let state = 'lobby', stateT = 0, roundTime = 0, endPending = -1, collapseT = 0, clock = 0, paused = false;
function show(id, on) { $(id).classList.toggle('hidden', !on); }
function toLobby() {
  state = 'lobby'; setPaused(false);
  if (NET.hosting) NET.room.broadcast({ t: 'tolobby' });
  show('lobby', true); show('end', false); show('hud', false); show('help', false); $('big').textContent = '';
  for (const p of players) { scene.remove(p.g.root); scene.remove(p.g.ring); }
  players = []; buildArena(settings.map === 'random' ? mapId : settings.map); clearPickups(); renderLobby();
}
function startMatch() {
  if (NET.client) return;
  createPlayers();
  NET.ev.length = 0;
  if (NET.hosting) NET.room.broadcast({ t: 'start', slots: slotState, names: NET.names, map: mapId, target: settings.target });
  show('lobby', false); show('end', false); show('hud', true); show('help', true);
  startRound();
}
function startRound() {
  hitStop = 0; slowT = 0;
  if (settings.map === 'random') {
    const pick = MAP_IDS.filter((id) => id !== mapId);
    buildArena(pick[(Math.random() * pick.length) | 0]);
    feed(`Map: <b>${MAP.name}</b>`);
  } else if (mapId !== settings.map) buildArena(settings.map);
  resetTiles(); clearPickups(); clearPeels(); placePlayers(); emit('round', mapId);
  roundTime = 0; endPending = -1; collapseT = 12;
  state = 'countdown'; stateT = 3; lastBeep = 4;
  renderHud();
}
let lastBeep = 4;
function setPaused(v) {
  if (state !== 'play' && state !== 'countdown' && state !== 'roundEnd') v = false;
  if (v && NET.client) { if (confirm('Leave the online match?')) leaveOnline(); return; }
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
  if (w) { w.score++; big(`${w.slot.name} WINS THE ROUND`, w.slot.css, 2.6); sfx.win(); emit('win'); }
  else big('NOBODY WINS!', '#fff', 2.6);
  state = 'roundEnd'; stateT = 2.6; renderHud();
}
function showMatchEnd() {
  const w = players.reduce((a, b) => (b.score > a.score ? b : a));
  state = 'end'; show('end', true); show('help', false); $('big').textContent = '';
  $('endTitle').textContent = `${w.slot.name} IS THE CHAMPION!`; $('endTitle').style.cssText = `font-size:clamp(36px,7vw,72px);color:${w.slot.css};background:none;-webkit-text-fill-color:${w.slot.css}`;
  $('endStats').innerHTML = players.map((p) => `<div style="--c:${p.slot.css}"><b>${who(p)}</b>${p.score} rounds · ${p.kos} bonk-offs</div>`).join('');
  sfx.win();
  emit('end', $('endTitle').textContent, w.slot.css, $('endStats').innerHTML);
  // this browser's players: the local humans (and, for a friend online, their own slot)
  const mine = players.filter((p) => !p.cpu && !p.net);
  stats.matches++; if (mine.includes(w)) stats.wins++; stats.bonkoffs += mine.reduce((n, p) => n + p.kos, 0);
  if (NET.hosting && NET.room.conns.size) stats.online++;
  saveStats();
}

// ---------------- simulation ----------------
const massOf = (p) => (p.mega > 0 ? 2.6 : 1);
function botInput(p, dt) {
  const ai = p.ai, lvl = CPU[settings.cpu];
  ai.think -= dt;
  if (ai.think <= 0) {
    ai.think = lvl.think * (0.7 + Math.random() * 0.6);
    ai.safe = safeSpot(p);
    let best = null, bd = 1e9;
    for (const o of players) { if (o === p || !o.alive || o.falling) continue; const d = Math.hypot(o.x - p.x, o.z - p.z); if (d < bd) { bd = d; best = o; } }
    let pk = null, pd = 1e9;
    for (const k of pickups) { const d = Math.hypot(k.x - p.x, k.z - p.z); if (d < pd) { pd = d; pk = k; } }
    if (pk && (!best || pd < bd * 0.7)) ai.goal = { x: pk.x, z: pk.z };
    else if (best && settings.cpu !== 'easy') { // aim slightly on the safe side of the target so the hit pushes it outward
      const cx = ai.safe.x - best.x, cz = ai.safe.z - best.z, cl = Math.hypot(cx, cz) || 1;
      ai.goal = { x: best.x + cx / cl * 0.5, z: best.z + cz / cl * 0.5 };
    } else if (best) ai.goal = { x: best.x, z: best.z };
    else ai.goal = { ...ai.safe };
    ai.target = best; ai.dist = bd;
  }
  let dx = ai.goal.x - p.x, dz = ai.goal.z - p.z, l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
  const here = tileAt(p.x, p.z);
  const look = MAP.ice ? 1.0 : 0.4;
  const peelAhead = peels.some((b) => b.owner !== p && Math.hypot(b.x - (p.x + dx * 0.9), b.z - (p.z + dz * 0.9)) < 0.7);
  if (!solid(p.x + p.vx * look + dx * 0.7, p.z + p.vz * look + dz * 0.7) || (here && here.state === 'warn') || Math.hypot(p.vx, p.vz) > 9 || peelAhead) {
    dx = ai.safe.x - p.x; dz = ai.safe.z - p.z; l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    return { x: dx, y: dz, dash: false };
  }
  let dash = false;
  if (ai.target && ai.dist < lvl.range && p.dashCd <= 0 && Math.random() < dt * lvl.aggr * ai.aggr) {
    const tx = (ai.target.x - p.x) / ai.dist, tz = (ai.target.z - p.z) / ai.dist;
    if (solid(p.x + tx * 2.4, p.z + tz * 2.4)) { dash = true; dx = tx; dz = tz; }
  }
  return { x: dx * lvl.push, y: dz * lvl.push, dash };
}

function simulate(dt) {
  const canMove = state === 'play' || state === 'roundEnd';
  for (const p of players) {
    if (!p.alive) continue;
    p.dashCd -= dt; p.dashT -= dt; p.hitT -= dt; p.mega -= dt; p.zoom -= dt; p.magnet = (p.magnet || 0) - dt;
    if (p.magnet > 0 && !p.falling) for (const o of players) {
      if (o === p || !o.alive || o.falling) continue;
      const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz) || 1;
      if (d < 9) { const f = 13 * (1 - d / 9) / massOf(o); o.vx += dx / d * f * dt; o.vz += dz / d * f * dt; }
    }
    p.sq *= Math.exp(-8 * dt);
    if (p.falling) {
      p.vy -= 32 * dt; p.y += p.vy * dt; p.x += p.vx * dt; p.z += p.vz * dt;
      if (p.y < -14) eliminate(p);
      continue;
    }
    const inp = canMove ? (p.cpu ? botInput(p, dt) : slotInput(p.i)) : { x: 0, y: 0, dash: false };
    // grip: normal ground stops you fast (easy to control), ice barely does
    const slipping = p.slip > 0;
    const grip = MAP.ice || slipping ? 1.2 : 5, dashGrip = MAP.ice || slipping ? 0.7 : 1.1;
    const here = tileAt(p.x, p.z);
    if (canMove && here && here.belt && here.state !== 'gone') p.vx += here.belt * 11 * dt * (p.mega > 0 ? 0.6 : 1);
    if (slipping) { p.slip -= dt; p.face += dt * 14; p.sq = Math.max(p.sq, 0.25); }
    const spd = p.zoom > 0 ? 1.45 : 1, acc = (MAP.ice ? 17 : 36) * spd / (p.mega > 0 ? 1.2 : 1);
    p.vx += inp.x * acc * dt; p.vz += inp.y * acc * dt;
    if (inp.dash && p.dashCd <= 0) {
      let dx = inp.x, dz = inp.y, l = Math.hypot(dx, dz);
      if (l < 0.2) { dx = Math.sin(p.face); dz = Math.cos(p.face); l = 1; }
      p.vx += dx / l * 14 * spd; p.vz += dz / l * 14 * spd;
      p.dashCd = p.zoom > 0 ? 0.4 : 0.75; p.dashT = 0.24; p.sq = 0.8;
      sfx.dash(); burst(p.x, 0.2, p.z, 0xffffff, 6, 2.5); emit('dash', p.i);
    }
    const fr = Math.exp(-(p.dashT > 0 ? dashGrip : grip) * dt); p.vx *= fr; p.vz *= fr;
    p.x += p.vx * dt; p.z += p.vz * dt;
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > 0.6) { let d = Math.atan2(p.vx, p.vz) - p.face; d = Math.atan2(Math.sin(d), Math.cos(d)); p.face += d * Math.min(1, 12 * dt); }
    const target = p.mega > 0 ? 1.6 : 1; p.scale += (target - p.scale) * Math.min(1, 8 * dt);
    p.teeter = !solid(p.x, p.z);
    if (!supported(p.x, p.z)) { p.falling = true; p.vy = 2; sfx.fall(); p.g.ring.visible = false; emit('fall', p.i); }
  }
  // blob vs bumper posts
  for (const t of bumpers) {
    if (t.state === 'gone') continue;
    for (const p of players) {
      if (!p.alive || p.falling) continue;
      const dx = p.x - t.x, dz = p.z - t.z, d = Math.hypot(dx, dz), rr = 0.47 + 0.55 * p.scale;
      if (d >= rr || d < 1e-5) continue;
      const nx = dx / d, nz = dz / d;
      p.x = t.x + nx * rr; p.z = t.z + nz * rr;
      const vn = p.vx * nx + p.vz * nz;
      if (vn < 0) { p.vx -= 2 * vn * nx; p.vz -= 2 * vn * nz; }
      const out = p.vx * nx + p.vz * nz, kick = Math.max(0, 11 - out);
      p.vx += nx * kick; p.vz += nz * kick;
      p.sq = 0.8; t.bump = 1;
      tone(520, 0.18, 'sine', 0.2, 900); burst(t.x + nx * 0.5, 0.6, t.z + nz * 0.5, 0xff3d9a, 8, 4); emit('bump', tiles.indexOf(t), +(t.x + nx * 0.5).toFixed(2), +(t.z + nz * 0.5).toFixed(2));
    }
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
    const j = -1.75 * rv / (1 / ma + 1 / mb);
    A.vx -= j / ma * nx; A.vz -= j / ma * nz; B.vx += j / mb * nx; B.vz += j / mb * nz;
    const bonusB = A.dashT > 0 ? 5 * Math.sqrt(ma / mb) : 0, bonusA = B.dashT > 0 ? 5 * Math.sqrt(mb / ma) : 0;
    B.vx += nx * bonusB; B.vz += nz * bonusB; A.vx -= nx * bonusA; A.vz -= nz * bonusA;
    const str = -rv + bonusA + bonusB;
    A.lastHit = { by: B, t: clock }; B.lastHit = { by: A, t: clock };
    A.hitT = B.hitT = 0.3; A.sq = B.sq = Math.min(1, str / 10);
    sfx.bonk(str);
    const cx = A.x + nx * 0.55 * A.scale, cz = A.z + nz * 0.55 * A.scale;
    emit('bonk', A.i, B.i, +str.toFixed(1), +cx.toFixed(2), +cz.toFixed(2));
    burst(cx, 0.6, cz, A.slot.color, 5 + (str | 0) / 2, 3 + str * 0.25); burst(cx, 0.6, cz, B.slot.color, 5 + (str | 0) / 2, 3 + str * 0.25);
    if (str > 12) shake = Math.max(shake, Math.min(0.5, str * 0.025));
    if (str > 12) hitStop = Math.max(hitStop, Math.min(0.09, 0.03 + str * 0.002)); // big bonks land with a beat of freeze
  }
  // banana peels
  for (const b of [...peels]) {
    b.t += dt;
    const t = tileAt(b.x, b.z);
    let hit = null;
    for (const q of players) if (q.alive && !q.falling && (q !== b.owner || b.t > 1.2) && Math.hypot(q.x - b.x, q.z - b.z) < 0.55 * q.scale + 0.25) { hit = q; break; }
    if (hit) { hit.slip = 1.4; const a = Math.random() * 6.28; hit.vx += Math.cos(a) * 6; hit.vz += Math.sin(a) * 6; tone(380, 0.25, 'triangle', 0.25, 120); emit('slip', hit.i); feed(`<span style="color:${hit.slot.css}">${hit.slot.name}</span> slipped on a banana!`); }
    if (hit || b.t > 12 || !t || t.state === 'gone') { scene.remove(b.mesh); peels.splice(peels.indexOf(b), 1); }
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

const WARN_RED = new THREE.Color(0xff3b3b), BELT_GLOW = new THREE.Color(0xffd27a);
function turnArena(dt) {
  if (!MAP.spin) return;
  const w = MAP.spin * dt; spinA += w;
  const c = Math.cos(spinA), sn = Math.sin(spinA), cw = Math.cos(w), sw = Math.sin(w);
  for (const t of tiles) {
    t.x = t.ax * c - t.az * sn; t.z = t.ax * sn + t.az * c;
    if (t.state !== 'gone') { t.mesh.position.x = t.x; t.mesh.position.z = t.z; t.mesh.rotation.y = -spinA; }
  }
  if (NET.client) return; // the host moves the blobs and pickups
  const carry = (o) => { const x = o.x * cw - o.z * sw; o.z = o.x * sw + o.z * cw; o.x = x; };
  for (const pl of players) if (pl.alive && !pl.falling && solid(pl.x, pl.z)) { carry(pl); pl.face -= w; }
  for (const k of pickups) { carry(k); k.mesh.position.x = k.x; k.mesh.position.z = k.z; }
  for (const b of peels) { carry(b); b.mesh.position.x = b.x; b.mesh.position.z = b.z; }
}
function updateTiles(dt) {
  if (!NET.client) turnArena(dt);
  // belts: a light that slides along each belt row
  if (MAP.belt) for (const t of tiles) if (t.belt && t.state === 'ok') { const k = (Math.sin((t.x * t.belt) * 1.4 - performance.now() / 180) + 1) / 2; t.top.color.copy(t.base).lerp(BELT_GLOW, k * 0.35); }
  if (state === 'play' && !NET.client) {
    const okCount = updateCentroid();
    collapseT -= dt;
    const floor = roundTime > 75 ? 1 : 7;
    if (collapseT <= 0 && okCount > floor) {
      collapseT = Math.max(0.6, 2.0 - (roundTime - 12) * 0.03);
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
      t.top.color.copy(t.base).lerp(WARN_RED, 0.4 + flash * 0.5);
      t.mesh.position.set(t.x + (Math.random() - 0.5) * 0.08, 0, t.z + (Math.random() - 0.5) * 0.08);
      if (t.t <= 0) {
        t.state = 'gone'; t.vy = 0; t.spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(3);
        sfx.crumble(); burst(t.x, -0.2, t.z, MAP.side, 8, 3);
      }
    } else if (t.state === 'gone' && t.mesh.visible) {
      t.vy -= 22 * dt; t.mesh.position.y += t.vy * dt;
      t.mesh.rotation.x += t.spin.x * dt; t.mesh.rotation.z += t.spin.z * dt;
      if (t.mesh.position.y < -40) t.mesh.visible = false;
    }
  }
}

const camDrift = new THREE.Vector3();
function render(dt, time) {
  const top = players.length ? Math.max(...players.map((p) => p.score)) : 0;
  for (const p of players) {
    const g = p.g;
    if (!p.alive) { g.ring.visible = false; continue; }
    const sp = Math.hypot(p.vx, p.vz), hop = p.falling ? 0 : Math.abs(Math.sin(time * 14)) * Math.min(0.12, sp * 0.02);
    g.root.position.set(p.x, p.y + hop, p.z); g.root.rotation.y = p.face; g.root.scale.setScalar(p.scale);
    if (p.falling) g.root.rotation.x += dt * 6;
    else g.root.rotation.x = 0;
    g.root.rotation.z = p.teeter && !p.falling ? Math.sin(time * 28) * 0.18 : 0; // wobble on the edge
    g.squash.scale.set(1 + p.sq * 0.3, 1 - p.sq * 0.32, 1 + p.sq * 0.3);
    g.mat.emissiveIntensity = p.zoom > 0 ? 0.35 + Math.sin(time * 18) * 0.25 : p.magnet > 0 ? 0.3 + Math.sin(time * 9) * 0.2 : p.mega > 0 ? 0.25 : 0;
    g.crown.visible = top > 0 && p.score === top;
    g.ring.position.set(p.x, 0.03, p.z); g.ring.scale.setScalar(p.scale);
    g.ring.material.opacity = p.dashCd > 0 ? 0.25 : 0.9;
  }
  for (const t of bumpers) { t.bump *= Math.exp(-10 * dt); t.bumper.scale.set(1 + t.bump * 0.35, 1 - t.bump * 0.3, 1 + t.bump * 0.35); }
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
  if (state === 'lobby') camDrift.set(Math.sin(time * 0.15) * 6, 0, Math.cos(time * 0.15) * 4 - 2); else camDrift.set(0, 0, 0);
  camera.position.copy(camBase).add(camDrift);
  const sk = shake * settings.shake;
  camera.position.x += (Math.random() - 0.5) * sk; camera.position.y += (Math.random() - 0.5) * sk;
  camera.lookAt(0, 0, 0.8);
  renderer.render(scene, camera);
}

// ---------------- main loop ----------------
let last = performance.now();
function frame(now) {
  const raw = (now - last) / 1000, dt = Math.min(0.05, raw); last = now;
  if (NET.client) { clientFrame(dt, now); return; }
  if (state !== 'lobby' && !paused && settings.autoRes) gov.tick(raw);
  pollPads();
  const escape = pressed.has('Escape') || anyPadPressed(9);
  if (setOpen) { if (escape || anyPadPressed(1)) closeSettings(); }
  else if (state === 'lobby') lobbyInput();
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
      if (n !== lastBeep && n > 0) { lastBeep = n; big(String(n), '#fff', 1); sfx.beep(false); emit('beep', 0); }
      if (stateT <= 0) { state = 'play'; big('BONK!', '#ffc62e', 0.8); sfx.beep(true); emit('beep', 1); }
    } else if (state === 'play') {
      roundTime += dt;
      pickTimer -= dt;
      if (pickTimer <= 0) { pickTimer = 5 + Math.random() * 3; if (pickups.length < 2) spawnPickup(); }
      if (endPending < 0 && players.filter((p) => p.alive && !p.falling).length <= 1) { endPending = 1.0; slowT = 0.7; }
      if (endPending >= 0) { endPending -= dt; if (endPending < 0) finishRound(); }
    } else if (state === 'roundEnd') {
      stateT -= dt;
      if (stateT <= 0) { if (players.some((p) => p.score >= settings.target)) showMatchEnd(); else startRound(); }
    }
    let sdt = dt;
    if (hitStop > 0) { hitStop -= dt; sdt = 0; } else if (slowT > 0) { slowT -= dt; sdt = dt * 0.35; }
    if (sdt > 0) { simulate(sdt); updateTiles(sdt); }
  }
  if (NET.hosting && NET.room.conns.size && state !== 'lobby') { NET.snapT -= dt; if (NET.snapT <= 0) { NET.snapT = 0.05; sendSnap(); } }
  if (bigTimer > 0) { bigTimer -= dt; if (bigTimer <= 0) $('big').textContent = ''; }
  render(paused || hitStop > 0 ? 0 : slowT > 0 ? dt * 0.35 : dt, now / 1000);
  pressed.clear();
  requestAnimationFrame(frame);
}
// ---------------- achievements + sync (sync.js) ----------------
if (window.GameSync) GameSync.init({ game: 'bonkbowl', keys: [{ match: 'bonkbowl.stats', mode: 'max' }], idle: () => state === 'lobby', ach: [
  { id: 'champ', name: 'Champion', desc: 'Win a match', test: (g) => ((g('bonkbowl.stats') || {}).wins || 0) > 0 },
  { id: 'bonk10', name: 'Bonk-off', desc: 'Knock 10 blobs off in total', test: (g) => ((g('bonkbowl.stats') || {}).bonkoffs || 0) >= 10 },
  { id: 'bonk100', name: 'Bowling ball', desc: 'Knock 100 blobs off in total', test: (g) => ((g('bonkbowl.stats') || {}).bonkoffs || 0) >= 100 },
  { id: 'online', name: 'Long distance', desc: 'Play an online match', test: (g) => ((g('bonkbowl.stats') || {}).online || 0) > 0 },
  { id: 'regular', name: 'Regular', desc: 'Play 25 matches', test: (g) => ((g('bonkbowl.stats') || {}).matches || 0) >= 25 }
] });

// ---------------- online play ----------------
const r2 = (v) => Math.round(v * 100) / 100;
const TILE_CH = { ok: 'o', warn: 'w', gone: 'g' };
function sendSnap() {
  NET.room.broadcast({ t: 's', st: state, mp: mapId, pl: players.map((p) => [p.i, r2(p.x), r2(p.y), r2(p.z), r2(p.vx), r2(p.vz), r2(p.face), (p.alive ? 1 : 0) | (p.falling ? 2 : 0) | (p.teeter ? 4 : 0) | (p.mega > 0 ? 8 : 0) | (p.zoom > 0 ? 16 : 0) | (p.dashCd > 0 ? 32 : 0) | (p.magnet > 0 ? 64 : 0) | (p.slip > 0 ? 128 : 0), r2(p.scale), p.score, p.kos]),
    sa: r2(spinA), pe: peels.map((b) => [r2(b.x), r2(b.z)]),
    ti: tiles.map((t) => TILE_CH[t.state]).join(''), pk: pickups.map((k) => [k.type, r2(k.x), r2(k.z), r2(k.t)]), ev: NET.ev.splice(0) });
}
function onHostMsg(id, m) {
  if (!m || typeof m !== 'object') return;
  const slot = NET.peerSlot.get(id);
  if (m.t === 'in' && slot !== undefined) {
    const n = NET.input[slot] || (NET.input[slot] = { x: 0, y: 0, dash: false });
    n.x = Math.max(-1, Math.min(1, +m.x || 0)); n.y = Math.max(-1, Math.min(1, +m.y || 0)); if (m.d) n.dash = true;
  }
}
function onPeerJoin(id, name) {
  const free = slotState.findIndex((s) => s === 'empty');
  const slot = free >= 0 ? free : slotState.findIndex((s) => s === 'cpu');
  if (slot < 0 || state !== 'lobby') { NET.room.send(id, { t: 'full', why: state !== 'lobby' ? 'The match already started. Ask the host to go back to the lobby.' : 'The room is full.' }); setTimeout(() => NET.room.kick(id), 300); return; }
  NET.peerSlot.set(id, slot); slotState[slot] = 'net'; NET.names[slot] = String(name).slice(0, 16); NET.input[slot] = { x: 0, y: 0, dash: false };
  NET.room.send(id, { t: 'welcome', slot });
  sfx.beep(false); feed(`🌐 <b>${esc(NET.names[slot])}</b> joined`);
  renderLobby();
}
function onPeerLeave(id) {
  const slot = NET.peerSlot.get(id); if (slot === undefined) return;
  NET.peerSlot.delete(id);
  feed(`🌐 <b>${esc(NET.names[slot] || 'A friend')}</b> left`);
  if (state === 'lobby') { slotState[slot] = 'empty'; NET.names[slot] = ''; renderLobby(); }
  else { slotState[slot] = 'cpu'; const p = players.find((q) => q.i === slot); if (p) { p.cpu = true; p.net = false; } renderHud(); } // a CPU takes over mid-match
}
// ---- a friend's browser: draw what the host sends
function onClientMsg(id, m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'welcome') { NET.mySlot = m.slot; netStatus(); }
  else if (m.t === 'lobby') { for (let i = 0; i < 3; i++) slotState[i] = m.slots[i]; NET.names = m.names; settings.target = m.target; if (state === 'lobby') { if (m.map !== 'random' && MAPS[m.map] && mapId !== m.map) buildArena(m.map); renderLobby(); } }
  else if (m.t === 'start') { for (let i = 0; i < 3; i++) slotState[i] = m.slots[i]; NET.names = m.names; settings.target = m.target; if (MAPS[m.mp || m.map]) buildArena(m.mp || m.map); createPlayers(); placePlayers(); show('lobby', false); show('end', false); show('hud', true); show('help', false); state = 'countdown'; renderHud(); }
  else if (m.t === 'tolobby') { clientToLobby(); }
  else if (m.t === 'full') { alert(m.why || 'The room is full.'); leaveOnline(); }
  else if (m.t === 'kicked') { alert('The host removed you from the room.'); leaveOnline(); }
  else if (m.t === 's') NET.snap = m;
}
function clientToLobby() {
  state = 'lobby'; show('lobby', true); show('end', false); show('hud', false); show('help', false); $('big').textContent = '';
  for (const p of players) { scene.remove(p.g.root); scene.remove(p.g.ring); }
  players = []; clearPickups(); resetTiles(); renderLobby();
}
const pickMeshes = [];
function applySnap(s, dt) {
  if (s.mp !== mapId && MAPS[s.mp]) { buildArena(s.mp); }
  if (state !== s.st) { if (s.st === 'end') show('help', false); state = s.st; }
  for (const e of s.ev || []) clientEvent(e);
  s.ev = [];
  // blobs: ease toward the host's positions (and lead them by their speed a little)
  const k = Math.min(1, dt * 18);
  for (const a of s.pl) {
    const p = players.find((q) => q.i === a[0]); if (!p) continue;
    const f = a[7], alive = !!(f & 1), falling = !!(f & 2);
    if (alive && !p.alive) { p.g.root.visible = true; p.g.ring.visible = true; p.x = a[1]; p.z = a[3]; }
    p.x += (a[1] + a[4] * 0.03 - p.x) * k; p.y += (a[2] - p.y) * k; p.z += (a[3] + a[5] * 0.03 - p.z) * k;
    p.vx = a[4]; p.vz = a[5];
    let d = a[6] - p.face; d = Math.atan2(Math.sin(d), Math.cos(d)); p.face += d * k;
    p.alive = alive; p.falling = falling; p.teeter = !!(f & 4); p.mega = f & 8 ? 1 : 0; p.zoom = f & 16 ? 1 : 0; p.dashCd = f & 32 ? 1 : 0; p.magnet = f & 64 ? 1 : 0; p.slip = f & 128 ? 1 : 0;
    p.scale = a[8];
    if (p.score !== a[9] || p.kos !== a[10]) { p.score = a[9]; p.kos = a[10]; renderHud(); }
    if (!alive) p.g.root.visible = false;
  }
  // tiles: start warning / falling when the host says so (the falling itself is animated here)
  for (let i = 0; i < tiles.length && i < s.ti.length; i++) {
    const t = tiles[i], c = s.ti[i];
    if (c === 'o' && t.state !== 'ok') { t.state = 'ok'; t.t = 0; t.vy = 0; t.mesh.position.set(t.x, 0, t.z); t.mesh.rotation.set(0, 0, 0); t.mesh.visible = true; t.top.color.copy(t.base); }
    else if (c === 'w' && t.state === 'ok') { t.state = 'warn'; t.t = 1.3; }
    else if (c === 'g' && t.state !== 'gone') { t.state = 'warn'; t.t = 0; }
  }
  // the Carousel's turn, and banana peels
  if (MAP.spin && typeof s.sa === 'number') { spinA = s.sa - MAP.spin * dt; turnArena(dt); }
  while (peels.length > (s.pe || []).length) scene.remove(peels.pop().mesh);
  (s.pe || []).forEach((q, i) => { if (!peels[i]) dropPeel(q[0], q[1], null); peels[i].x = q[0]; peels[i].z = q[1]; peels[i].mesh.position.set(q[0], 0.62, q[1]); });
  // pickups
  while (pickMeshes.length > s.pk.length) scene.remove(pickMeshes.pop().mesh);
  s.pk.forEach((q, i) => {
    let m = pickMeshes[i];
    if (!m || m.type !== q[0]) { if (m) scene.remove(m.mesh); const mesh = new THREE.Mesh(PICK[q[0]].geo, new THREE.MeshStandardMaterial({ color: PICK[q[0]].color, emissive: PICK[q[0]].color, emissiveIntensity: 0.6, roughness: 0.3 })); scene.add(mesh); m = pickMeshes[i] = { type: q[0], mesh, x: q[1], z: q[2], t: q[3] }; }
    m.x = q[1]; m.z = q[2]; m.t = q[3]; m.mesh.position.x = q[1]; m.mesh.position.z = q[2];
  });
  pickups = pickMeshes;
}
function clientEvent(e) {
  const [type, ...a] = e, P = (i) => players.find((q) => q.i === i);
  if (type === 'dash') { const p = P(a[0]); sfx.dash(); if (p) { burst(p.x, 0.2, p.z, 0xffffff, 6, 2.5); p.sq = 0.8; } }
  else if (type === 'fall') { sfx.fall(); const p = P(a[0]); if (p) p.g.ring.visible = false; }
  else if (type === 'bump') { tone(520, 0.18, 'sine', 0.2, 900); burst(a[1], 0.6, a[2], 0xff3d9a, 8, 4); const t = tiles[a[0]]; if (t) t.bump = 1; }
  else if (type === 'bonk') { const A = P(a[0]), B = P(a[1]), str = a[2]; sfx.bonk(str); if (A && B) { A.sq = B.sq = Math.min(1, str / 10); burst(a[3], 0.6, a[4], A.slot.color, 5 + (str | 0) / 2, 3 + str * 0.25); burst(a[3], 0.6, a[4], B.slot.color, 5 + (str | 0) / 2, 3 + str * 0.25); } if (str > 12) { shake = Math.max(shake, Math.min(0.5, str * 0.025)); hitStop = Math.max(hitStop, Math.min(0.09, 0.03 + str * 0.002)); } }
  else if (type === 'grab') { sfx.pickup(); burst(a[1], 0.7, a[2], PICK[a[0]].color, 14, 5); if (a[0] === 'quake') { sfx.quake(); shake = 0.6; const p = P(a[3]); if (p) shockwave(p.x, p.z, PICK.quake.color); } }
  else if (type === 'feed') { const d = document.createElement('div'); d.innerHTML = a[0]; $('feed').appendChild(d); setTimeout(() => d.remove(), 3500); }
  else if (type === 'big') { const b = $('big'); b.textContent = a[0]; b.style.color = a[1]; bigTimer = a[2]; b.classList.add('pop'); setTimeout(() => b.classList.remove('pop'), 120); }
  else if (type === 'beep') sfx.beep(!!a[0]);
  else if (type === 'slip') tone(380, 0.25, 'triangle', 0.25, 120);
  else if (type === 'win') sfx.win();
  else if (type === 'round') { if (MAPS[a[0]] && a[0] !== mapId) buildArena(a[0]); resetTiles(); for (const p of players) { p.alive = true; p.falling = false; p.g.root.visible = true; p.g.ring.visible = true; p.g.root.rotation.x = 0; } renderHud(); }
  else if (type === 'end') {
    { const me = players.find((q) => q.i === NET.mySlot); stats.matches++; stats.online++; if (me) { stats.bonkoffs += me.kos; if (NET.mySlot >= 0 && a[0].startsWith(SLOTS[NET.mySlot].name + ' ')) stats.wins++; } saveStats(); } show('end', true); $('endTitle').textContent = a[0]; $('endTitle').style.cssText = `font-size:clamp(36px,7vw,72px);color:${a[1]};background:none;-webkit-text-fill-color:${a[1]}`; $('endStats').innerHTML = a[2]; $('rematchBtn').classList.add('hidden'); $('lobbyBtn').textContent = 'Leave'; sfx.win(); }
}
let hitStopC = 0;
function clientFrame(dt, now) {
  pollPads();
  if (pressed.has('Escape') && state !== 'lobby') setPaused(true);
  if (state !== 'lobby') {
    const inp = clientInput(); if (inp.dash) NET.dashQ = true;
    NET.sendT -= dt;
    if (NET.sendT <= 0) { NET.sendT = 1 / 30; NET.room.send('h', { t: 'in', x: +inp.x.toFixed(2), y: +inp.y.toFixed(2), d: NET.dashQ }); NET.dashQ = false; }
  }
  if (NET.snap && state !== 'lobby') applySnap(NET.snap, dt);
  for (const p of players) p.sq *= Math.exp(-8 * dt);
  if (state !== 'lobby') updateTiles(dt); // only animates here (the host decides which tiles go)
  if (bigTimer > 0) { bigTimer -= dt; if (bigTimer <= 0) $('big').textContent = ''; }
  render(hitStop > 0 ? 0 : dt, now / 1000);
  if (hitStop > 0) hitStop -= dt;
  pressed.clear();
  requestAnimationFrame(frame);
}
// ---- the Online panel
function netStatus() {
  const el = $('netStatus'); if (!el) return;
  if (NET.hosting) el.innerHTML = `🌐 Room <b>${NET.room.code}</b> · ${NET.room.conns.size} friend${NET.room.conns.size === 1 ? '' : 's'} online`;
  else if (NET.client) el.innerHTML = `🌐 In room <b>${NET.room.code}</b>${NET.mySlot >= 0 ? ' as ' + SLOTS[NET.mySlot].name : ''} · move with WASD or the arrows, dash with Space / Q`;
  else el.textContent = '';
  $('onlineBtn').textContent = NET.hosting || NET.client ? '🌐 Online ✓' : '🌐 Online';
}
function leaveOnline() {
  if (NET.room) NET.room.close();
  const wasClient = NET.client;
  NET.room = null; NET.hosting = false; NET.client = false; NET.peerSlot.clear(); NET.mySlot = -1; NET.snap = null; NET.names = ['', '', ''];
  for (let i = 0; i < 3; i++) if (slotState[i] === 'net' || wasClient) slotState[i] = 'empty';
  $('rematchBtn').classList.remove('hidden'); $('lobbyBtn').textContent = 'Lobby (Esc)';
  if (wasClient) { pickMeshes.forEach((m) => scene.remove(m.mesh)); pickMeshes.length = 0; pickups = []; clientToLobby(); }
  else if (state !== 'lobby') toLobby(); else renderLobby();
  drawNet();
}
function drawNet(msg = '') {
  const box = $('netBody');
  const name = esc(store.get('name', ''));
  if (NET.hosting) {
    const link = location.origin + location.pathname + '?join=' + NET.room.code;
    box.innerHTML = `<p>Your room code:</p><div class="netCode">${NET.room.code}</div><p class="small">Friends open Bonk Bowl, press 🌐 Online and enter the code, or open this link:</p>
      <input class="netLink" readonly value="${link}"><div class="row"><button id="netCopy">Copy link</button><button id="netClose">Close room</button></div>
      <p class="small">Friends take the free slots. You can still add CPUs and local players.</p>`;
    $('netCopy').onclick = () => { navigator.clipboard?.writeText(link).then(() => ($('netCopy').textContent = 'Copied'), () => {}); };
    $('netClose').onclick = () => leaveOnline();
  } else if (NET.client) {
    box.innerHTML = `<p>You're in room <b>${NET.room.code}</b>. The host starts the match.</p><div class="row"><button id="netLeave">Leave room</button></div>`;
    $('netLeave').onclick = () => leaveOnline();
  } else {
    box.innerHTML = `<label class="netName">Your name <input id="netName" maxlength="16" value="${name}" placeholder="Player"></label>
      <div class="row"><button id="netHost">Host a room</button></div>
      <p class="small" style="margin-top:6px">or join a friend's room:</p>
      <div class="row"><input id="netCodeIn" maxlength="4" placeholder="CODE" autocomplete="off"><button id="netJoin">Join</button></div>
      <p class="netMsg">${msg}</p>`;
    const nm = () => { const v = $('netName').value.trim().slice(0, 16) || 'Player'; store.set('name', v); return v; };
    for (const el of [$('netName'), $('netCodeIn')]) { el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && el.id === 'netCodeIn') $('netJoin').click(); }); el.addEventListener('keyup', (e) => e.stopPropagation()); }
    $('netHost').onclick = async () => {
      nm(); $('netHost').disabled = true; box.querySelector('.netMsg').textContent = 'Opening a room…';
      const room = new Room();
      try { await room.hostRoom(); } catch (err) { drawNet(err.message); return; }
      NET.room = room; NET.hosting = true;
      room.onJoin = onPeerJoin; room.onLeave = onPeerLeave; room.onMsg = onHostMsg;
      drawNet(); renderLobby();
    };
    $('netJoin').onclick = async () => {
      const code = $('netCodeIn').value.toUpperCase().replace(/[^A-Z]/g, '');
      if (code.length !== 4) { box.querySelector('.netMsg').textContent = 'Codes are 4 letters.'; return; }
      $('netJoin').disabled = true; box.querySelector('.netMsg').textContent = 'Connecting…';
      const room = new Room();
      try { await room.join(code, nm()); } catch (err) { drawNet(err.message); return; }
      NET.room = room; NET.client = true;
      room.onMsg = onClientMsg; room.onLost = () => { alert('Lost the connection to the host.'); leaveOnline(); };
      for (let i = 0; i < 3; i++) slotState[i] = 'empty';
      drawNet(); renderLobby(); show('netPanel', false); show('lobby', true);
    };
  }
}
$('onlineBtn').addEventListener('click', () => { show('lobby', false); show('netPanel', true); drawNet(); });
$('netDone').addEventListener('click', () => { show('netPanel', false); show('lobby', true); renderLobby(); });
addEventListener('beforeunload', () => { if (NET.room) NET.room.close(); });
{ const j = new URLSearchParams(location.search).get('join'); if (j) setTimeout(() => { $('onlineBtn').click(); const el = $('netCodeIn'); if (el) el.value = j.toUpperCase().slice(0, 4); }, 300); }

if (settings.map !== 'random' && !MAPS[settings.map]) settings.map = 'meadow';
buildArena(settings.map === 'random' ? 'meadow' : settings.map);
renderLobby();
requestAnimationFrame(frame);
if (location.search.includes('test')) window.__bb = { info: () => ({ map: mapId, state, roundTime: +roundTime.toFixed(1), gone: tiles.filter((t) => t.state === 'gone').length, scores: players.map((p) => p.score), alive: players.map((p) => p.alive), pos: players.map((p) => [p.i, Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100]), spin: +spinA.toFixed(2), peels: peels.length, slip: players.map((p) => p.slip > 0), magnet: players.map((p) => p.magnet > 0), setMap: (m) => { settings.map = m; buildArena(m); }, give: (i, type) => { const p = players.find((q) => q.i === i); grab(p, { type, x: p.x, z: p.z }); }, net: NET.hosting ? 'host' : NET.client ? 'client' : '' }) };
