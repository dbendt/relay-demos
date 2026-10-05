// Relay Moto page: par off the main thread (each search takes a few seconds).
// Message: { job: 'par', key, id, pieces } -> { key, time, clean, events }
// The page caches the answers per set of pieces and works credit out itself from them (credit is only replays).
importScripts('moto-sim.js');
const M = self.RelayMoto;

onmessage = (e) => {
  const m = e.data, base = M.genTrack(m.id);
  if (m.job === 'par') {
    const p = M.par(M.trackWith(base, m.pieces));
    const events = p.log.filter((x) => x.e !== 'finish').map((x) => ({ e: x.e, x: Math.round(x.x / M.U), why: x.why || '' }));
    postMessage({ key: m.key, time: p.time, clean: !events.some((x) => x.e === 'crash' || x.e === 'overheat'), events });
  }
};
