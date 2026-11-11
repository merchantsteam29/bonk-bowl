// net.js: online rooms for Bonk Bowl over PeerJS (peer-to-peer, no server of our own).
// The host's PeerJS id is `bonkbowl-v1-<CODE>`; friends connect to it. The host runs the match and
// everyone else just sends their stick + dash and draws what the host sends back.
const PREFIX = 'bonkbowl-v1-';
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const newCode = () => Array.from({ length: 4 }, () => LETTERS[(Math.random() * LETTERS.length) | 0]).join('');

export class Room {
  constructor() {
    this.peer = null; this.conns = new Map(); this.host = false; this.code = null; this.nextId = 1;
    this.onMsg = () => {}; this.onJoin = () => {}; this.onLeave = () => {}; this.onLost = () => {};
  }
  get open() { return !!this.peer && !this.peer.destroyed; }
  // Host a room. Resolves with the code once PeerJS has registered it (tries a new code if one is taken).
  hostRoom(tries = 4) {
    if (!window.Peer) return Promise.reject(new Error('Online play could not load. Check your connection.'));
    return new Promise((resolve, reject) => {
      const code = newCode();
      const peer = new window.Peer(PREFIX + code);
      peer.on('open', () => { this.peer = peer; this.host = true; this.code = code; resolve(code); });
      peer.on('error', (e) => {
        if (!this.peer && e.type === 'unavailable-id' && tries > 0) { peer.destroy(); this.hostRoom(tries - 1).then(resolve, reject); }
        else if (!this.peer) { peer.destroy(); reject(new Error('Could not open a room (' + (e.type || 'network') + ').')); }
      });
      peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* closing */ } });
      peer.on('connection', (c) => {
        c.on('open', () => {
          const id = this.nextId++;
          c._id = id; this.conns.set(id, c);
          c.on('data', (d) => this.onMsg(id, d));
          c.on('close', () => { if (this.conns.delete(id)) this.onLeave(id); });
          c.on('error', () => {});
          this.onJoin(id, (c.metadata && c.metadata.name) || 'Friend');
        });
      });
    });
  }
  // Join a friend's room.
  join(code, name) {
    if (!window.Peer) return Promise.reject(new Error('Online play could not load. Check your connection.'));
    code = String(code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    return new Promise((resolve, reject) => {
      const peer = new window.Peer();
      const fail = (msg) => { clearTimeout(timer); try { peer.destroy(); } catch { /* gone */ } reject(new Error(msg)); };
      const timer = setTimeout(() => fail('No room with that code answered.'), 12000);
      peer.on('error', (e) => { if (!this.peer) fail(e.type === 'peer-unavailable' ? 'No room with that code.' : 'Could not connect (' + (e.type || 'network') + ').'); });
      peer.on('open', () => {
        const c = peer.connect(PREFIX + code, { reliable: true, metadata: { name } });
        c.on('open', () => {
          clearTimeout(timer);
          this.peer = peer; this.host = false; this.code = code;
          this.conns.set('h', c);
          c.on('data', (d) => this.onMsg('h', d));
          c.on('close', () => { if (this.conns.delete('h')) this.onLost(); });
          resolve(code);
        });
        c.on('error', () => {});
      });
    });
  }
  send(id, msg) { const c = this.conns.get(id); if (c && c.open) c.send(msg); }
  broadcast(msg) { for (const c of this.conns.values()) if (c.open) c.send(msg); }
  kick(id) { const c = this.conns.get(id); if (c) { this.conns.delete(id); try { c.close(); } catch { /* gone */ } } }
  close() { for (const c of this.conns.values()) { try { c.close(); } catch { /* gone */ } } this.conns.clear(); if (this.peer) { try { this.peer.destroy(); } catch { /* gone */ } } this.peer = null; this.host = false; this.code = null; }
}
