// Desk test for dragging samples out of Sample Browser onto LUNA's timeline.
//   node tests/live/drag.mjs [--session snaptest] [--minutes 6]
// Waits for the session, then watches while you drag. For every clip LUNA places it reports the
// track (new or existing, its warp mode), the clip (warp mode, length follows, tempo_candidate),
// the BPM LUNA stretched it to against the BPM the browser would use, the session tempo, and
// the undo list. Read-only: it never writes to the session. Undo your drops in LUNA when done.
import { Luna } from '@uaudio/luna-builder-sdk';
globalThis.Luna = Luna;
await import('../../logic.js');
const L = globalThis.AddOnLogic;

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const want = arg('--session', 'snaptest');
const minutes = Number(arg('--minutes', 6));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(stamp(), ...a);
const ALG = ['polyphonic', 'monophonic', 'efficient', 'soloist', 'varispeed', 'razor_blade', 'ua_stretch', 'clip_effect'];
const algName = (v) => (typeof v === 'number' ? (ALG[v] ?? `unset (${v})`) : v);

// Wait for LUNA and the session (Pete may be restarting LUNA to load the new page); after a
// restart, connect again and start over.
let luna, s, sources, notices0, tracks0, seen, sources0, previewAlg, lost = false;
const props = (path, filter) => luna.raw.get(path, { children: false, commands: false, flatvalue: true, ...(filter ? { propfilter: filter } : {}) }).then((n) => n.properties);
const undoUid = async () => (await props(s.path, 'undo_uid')).undo_uid;
const tempo = () => (s.musical.timeline.tempoLoaded ? s.musical.timeline.tempoAt(0) : undefined);
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('LUNA did not answer')), ms))]);

async function clipsOf(track) {
  const { playlist_uid: pl } = await props(track.path, 'playlist_uid');
  if (!pl) return [];
  const base = `${s.path}/playlists/${pl}/clips`;
  const c = await luna.raw.get(base, { levels: 1, properties: false, commands: false }).catch(() => null);
  return (c?.children ?? []).map((k) => `${base}/${k.path}`);
}

async function everything() {
  const out = new Map(); // clip path -> track
  for (const t of s.tracks.items) {
    if (t.name.value === 'Sample Preview') continue; // the browser's own previews come and go
    for (const p of await clipsOf(t)) out.set(p, t);
  }
  return out;
}

async function attach() {
  for (let i = 0; ; i++) {
    try {
      luna = await within(Luna.connect(), 5000);
      s = await within(luna.session(), 5000);
      if (s?.name.value === want) {
        lost = false;
        luna.raw.onStatus((st) => { if (st === 'disconnected' || st === 'closed') lost = true; });
        break;
      }
      if (i % 15 === 0) log(`open session is “${s?.name.value}”, waiting for “${want}”…`);
    } catch { if (i % 15 === 0) log('waiting for LUNA…'); }
    if (i > 900) { log('gave up waiting'); process.exit(1); }
    await pause(1000);
  }
  sources = await s.loadSources();
  await luna.errors.watch().ready;
  notices0 = luna.errors.sorted.length;
  tracks0 = new Set(s.tracks.items.map((t) => t.id));
  seen = new Set((await everything()).keys());
  sources0 = new Set(sources.items.map((x) => x.id));
  const preview = s.tracks.items.find((t) => t.name.value === 'Sample Preview');
  previewAlg = preview ? algName((await props(preview.path, 'alg_type')).alg_type) : undefined;
  log(`LIVE: session “${s.name.value}”, ${tempo()} BPM, tracks follow ${(await props(s.path, 'track_follows')).track_follows}; Sample Preview warp mode: ${previewAlg ?? '(no Sample Preview track yet)'}. Watching ${minutes} min: drag away.`);
}

async function report(path, track) {
  const first = await props(path, ['name', 'start']).catch(() => null);
  await pause(3500); // the page swaps LUNA's drop for its own placement within a few seconds
  const c = await props(path).catch(() => null);
  const undo = await luna.raw.get(`${s.path}/undo_queues`, { levels: 2, properties: true, commands: false, propfilter: ['rowid', 'name'], flatvalue: true }).catch(() => null);
  const names = (undo?.children ?? []).map((k) => k.properties).filter((p) => p?.rowid !== undefined).sort((x, y) => x.rowid - y.rowid).slice(-5).map((p) => p.name);
  if (!c || c.name === undefined) {
    log(`gone: “${first?.name}” at bar ${first ? s.musical.timeline.barBeat(first.start).bar : '?'} (LUNA's drop, undone by the page) · undo list ends: ${names.join(' › ')}`);
    return;
  }
  const isNewTrack = !tracks0.has(track.id);
  const t = await props(track.path, ['alg_type', 'follows']);
  const beats = (c.stop - c.start) / Luna.TICKS_PER_BEAT;
  const srcSec = (c.source_stop - c.source_start) / 1e9;
  const lunaBpm = srcSec > 0 ? (beats * 60) / srcSec : NaN;
  const src = sources.byId?.(c.source_uid);
  const file = src ? s.sourcePath(src) : undefined;
  const detected = file ? await L.detectTempo(luna, file) : null;
  const plan = L.resolveTempo({ name: c.name ?? '', seconds: src?.seconds ?? srcSec, detected });
  log(`CLIP “${c.name}” on ${isNewTrack ? 'NEW track' : 'track'} “${track.name.value}” (track warp ${algName(t.alg_type)}) at ${Luna.formatBarBeat(s.musical.timeline.barBeat(c.start))}`);
  log(`  clip warp ${c.alg_type}, follows ${c.length_follows}, plays as ${lunaBpm.toFixed(2)} BPM; browser's rule says ${plan.kind === 'loop' ? plan.bpm.toFixed(2) : 'one-shot'}${plan.kind === 'loop' && Math.abs(plan.bpm - lunaBpm) > 0.05 ? '  ← DIFFERENT (or a ½×/2× fix)' : ''} · undo list ends: ${names.join(' › ')}`);
  const notices = luna.errors.sorted.slice(notices0);
  if (notices.length) log(`  LUNA notices so far: ${notices.map((e) => e.title.value).join(', ')}`);
}

await attach();
let end = Date.now() + minutes * 60e3;
const pending = [];
let fails = 0;
while (Date.now() < end) {
  if (lost) {
    log('LUNA went away (restart?): waiting for it to come back');
    await luna.raw.close().catch(() => undefined);
    await attach();
    end = Date.now() + minutes * 60e3;
  }
  try {
    for (const [path, track] of await within(everything(), 5000)) {
      if (seen.has(path)) continue;
      seen.add(path);
      pending.push(report(path, track).catch((e) => log(`  couldn't read ${path}: ${e.code ?? e.message}`)));
    }
    fails = 0;
  } catch (e) {
    if (++fails >= 3) { log(`lost LUNA (${e.code ?? e.message}): waiting for it to come back`); await attach(); end = Date.now() + minutes * 60e3; fails = 0; }
  }
  await pause(700);
}
await Promise.all(pending);
const notices = luna.errors.sorted.slice(notices0);
log(`done. LUNA raised no errors: ${notices.length ? `NO: ${notices.map((e) => e.title.value).join(', ')}` : true}`);
process.exit(0);
