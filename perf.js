// perf.js — frame-rate governor (shared across the games; same file in each).
// Watches real frame times. When the game can't hold ~50fps it trims render
// resolution a step at a time (down to `min`), and when there's headroom again
// it creeps back up. If dropping resolution didn't help (the slowdown is CPU /
// game logic, not pixels) it gives the pixels back and stops trying for a while,
// so a CPU-bound PC doesn't end up blurry for nothing.
//
//   const gov = createGovernor({ apply: (s) => renderer.setPixelRatio(base * s) });
//   every frame:  gov.tick(rawDeltaSeconds);
//   gov.scale     current multiplier, 0..1 (1 = full resolution)
//   gov.reset()   back to full resolution (e.g. when the quality setting changes)
export function createGovernor({ apply, min = 0.55, slowMs = 20, fastMs = 17.6, windowSec = 0.5 } = {}) {
  let scale = 1, acc = 0, n = 0, calm = 0, need = 6, hold = 0, before = 0, cpuBound = 0, backoff = 40;
  const set = (s) => {
    s = Math.max(min, Math.min(1, s));
    if (Math.abs(s - scale) < 0.01) return false;
    scale = s; apply(scale); return true;
  };
  return {
    get scale() { return scale; },
    reset() { calm = 0; need = 6; hold = 0; before = 0; cpuBound = 0; backoff = 40; set(1); },
    tick(dt) {
      if (!(dt > 0) || dt > 0.25) return; // tab switch / loading hitch: not a steady-state signal
      acc += dt; n++;
      if (acc < windowSec) return;
      const ms = (acc / n) * 1000; acc = 0; n = 0;
      if (hold > 0) { // let the last change settle before judging again
        if (--hold === 0 && before) {
          if (ms > before * 0.93) { cpuBound = backoff; backoff = Math.min(backoff * 2, 1200); set(scale / 0.85); } // fewer pixels didn't help → not GPU-bound
          before = 0;
        }
        return;
      }
      if (cpuBound > 0) cpuBound--;
      if (ms > slowMs) {
        calm = 0;
        if (!cpuBound && scale > min && set(scale * 0.85)) { before = ms; hold = 3; }
      } else if (ms < fastMs && scale < 1) {
        if (++calm >= need) { calm = 0; set(scale * 1.1); hold = 3; need = scale >= 1 ? 6 : Math.min(need * 2, 60); }
      } else calm = 0;
    },
  };
}
