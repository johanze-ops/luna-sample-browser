// Read-only: session warp settings, and every track's warp mode with its clips' start and warp mode.
import { Luna } from '@uaudio/luna-builder-sdk';
const luna = await Luna.connect(); const s = await luna.session();
const get = (p, f) => luna.raw.get(p, { children: false, commands: false, flatvalue: true, ...(f ? { propfilter: f } : {}) }).then((n) => n.properties);
const sp = await get(s.path);
console.log('session', s.name.value, JSON.stringify(Object.fromEntries(Object.entries(sp).filter(([k]) => /alg|warp|stretch|snap|grid|follow/.test(k)))));
const tl = s.musical.timeline;
for (const t of s.tracks.items) {
  const n = await get(t.path);
  const keys = Object.keys(n).filter((k) => /alg|warp|stretch|follow/.test(k));
  const pl = n.playlist_uid;
  const base = `${s.path}/playlists/${pl}/clips`;
  const c = pl ? await luna.raw.get(base, { levels: 1, properties: false, commands: false }).catch(() => null) : null;
  const clips = [];
  for (const k of c?.children ?? []) {
    const cp = await get(`${base}/${k.path}`, ['name', 'start', 'stop', 'alg_type', 'length_follows', 'tempo_candidate', 'source_start', 'source_stop']);
    const beats = (cp.stop - cp.start) / Luna.TICKS_PER_BEAT, sec = (cp.source_stop - cp.source_start) / 1e9;
    clips.push(`${cp.name} @${Luna.formatBarBeat(tl.barBeat(cp.start))} ${cp.alg_type} ${cp.length_follows} ${(beats * 60 / sec).toFixed(2)}bpm cand=${JSON.stringify(cp.tempo_candidate)}`);
  }
  console.log(`${t.name.value}: ${JSON.stringify(Object.fromEntries(keys.map((k) => [k, n[k]])))}\n   ${clips.join('\n   ')}`);
}
process.exit(0);
