// Runs against Luna.MockEngine and plain data: no LUNA needed. `npm test`.
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna; // logic.js is a classic script that reads the Luna global
await import('../logic.js');
const L = globalThis.AddOnLogic;

describe('tempo from the file name', () => {
  it.each([
    ['076bpmPINKOfull1.wav', 76],
    ['169bpmWOODYwet3 .wav', 169],
    ['Drum Loop 120 BPM.wav', 120],
    ['drums_bpm95_Am.wav', 95],
    ['house-128-bpm-groove.aif', 128],
    ['Splice_Top_Loop_92_bpm_Cmin.wav', 92],
    ['mystery-loop.wav', null],
    ['kick_909.wav', null],
    ['take 2024.wav', null],
  ])('%s -> %s', (name, bpm) => expect(L.nameBpm(name)).toBe(bpm));
});

describe('folding a detected tempo', () => {
  it('doubles half-time results into the range', () => {
    expect(L.fold(71, 75, 150)).toBe(142);
    expect(L.fold(42.25, 75, 150)).toBe(84.5);
    expect(L.fold(79, 75, 150)).toBe(79);
    expect(L.fold(169, 75, 150)).toBe(84.5);
    expect(L.fold(169, 85, 170)).toBe(169);
  });
});

describe('whole bars and tempo from length', () => {
  it('recognises whole-bar loops', () => {
    expect(L.wholeBars(12.151655, 79)).toBe(4);
    expect(L.wholeBars(25.262948, 76)).toBe(8);
    expect(L.wholeBars(10.323, 79)).toBe(null); // a hand-trimmed file
  });
  it('guesses the tempo of mystery-loop from its length', () => {
    expect(L.lengthBpm(12.151655, 75, 150)).toBeCloseTo(79, 1);
  });
});

describe('resolveTempo', () => {
  const range = [75, 150];
  it('uses the name first', () => {
    expect(L.resolveTempo({ name: '079bpmX.wav', seconds: 12.15, detected: 40, range })).toMatchObject({ kind: 'loop', bpm: 79, source: 'name', bars: 4 });
  });
  it('uses LUNA, folded, when the name has no BPM', () => {
    expect(L.resolveTempo({ name: 'mystery-loop.wav', seconds: 12.151655, detected: 79.0016, range })).toMatchObject({ kind: 'loop', source: 'luna', bars: 4 });
    const r = L.resolveTempo({ name: 'x.wav', seconds: 6.7605, detected: 71.003, range }); // 4 bars at 142
    expect(r.bpm).toBeCloseTo(142, 1);
    expect(r.bars).toBe(4);
  });
  it('a user-set tempo wins', () => {
    expect(L.resolveTempo({ name: '076bpmX.wav', seconds: 25.26, override: 152, range })).toMatchObject({ bpm: 152, source: 'set' });
  });
  it('falls back to the length', () => {
    expect(L.resolveTempo({ name: 'x.wav', seconds: 12.151655, detected: null, range })).toMatchObject({ kind: 'loop', source: 'length', bars: 4 });
  });
  it('short files without a BPM are one-shots', () => {
    expect(L.resolveTempo({ name: 'kick.wav', seconds: 0.4, detected: 120, range }).kind).toBe('oneshot');
  });
});

describe('loop maths', () => {
  it('lays copies back to back until the target', () => {
    expect(L.loopTicks(12.151655, 79)).not.toBe(16 * Luna.TICKS_PER_BEAT); // 15.9997 beats: would drift
    const len = L.loopTicks(12.151655, 79, 4); // snapped to 4 bars
    expect(len).toBe(16 * Luna.TICKS_PER_BEAT);
    const spans = L.loopSpans(0, len, 3 * len);
    expect(spans).toEqual([[0, len], [len, 2 * len], [2 * len, 3 * len]]);
  });
});

describe('filling a loop range', () => {
  const B = Luna.TICKS_PER_BEAT, BAR = 4 * B;
  it('fills the loop range in phase with the loop start, leaving the current bar for later', () => {
    // LUNA loops bars 1-5 (16 beats); a 2-bar sample; clicked in bar 2, so it comes in at bar 3.
    const len = 2 * BAR, ns = 4e9;
    const pieces = L.tilePieces(0, len, [[0, 1 * BAR], [2 * BAR, 4 * BAR]], ns);
    expect(pieces).toEqual([
      { startTick: 0, stopTick: BAR, sourceStartNs: 0, sourceStopNs: 2e9 },          // 1st half of pass 1, before the gap
      { startTick: 2 * BAR, stopTick: 4 * BAR, sourceStartNs: 0, sourceStopNs: 4e9 }, // pass 2, whole
    ]);
    // The gap (bar 2) is filled later with the 2nd half of pass 1.
    expect(L.tilePieces(0, len, [[BAR, 2 * BAR]], ns)).toEqual([{ startTick: BAR, stopTick: 2 * BAR, sourceStartNs: 2e9, sourceStopNs: 4e9 }]);
  });
  it('cuts the last pass at the loop end', () => {
    const len = 3 * BAR; // a 3-bar sample in a 4-bar loop range
    const pieces = L.tilePieces(0, len, [[0, 4 * BAR]], 6e9);
    expect(pieces.map((p) => [p.startTick / BAR, p.stopTick / BAR, p.sourceStartNs, p.sourceStopNs])).toEqual([[0, 3, 0, 6e9], [3, 4, 0, 2e9]]);
  });
});

describe('one-shots in time', () => {
  const B = Luna.TICKS_PER_BEAT, BAR = 4 * B;
  it('strikes once per bar, unwarped, cut short by the next hit', () => {
    const hit = B / 2; // a short kick: an eighth note long at this tempo
    const p = L.hitPieces(0, BAR, [[0, 3 * BAR]], hit, 250e6);
    expect(p.map((x) => [x.startTick / BAR, x.stopTick - x.startTick, x.sourceStopNs])).toEqual([[0, hit, 250e6], [1, hit, 250e6], [2, hit, 250e6]]);
    const long = L.hitPieces(0, B, [[0, 2 * B]], 3 * B, 3e9); // a long crash struck every beat
    expect(long.map((x) => [x.startTick, x.stopTick - x.startTick, x.sourceStopNs])).toEqual([[0, B, 1e9], [B, B, 1e9]]);
  });
  it('skips the bar being played and keeps the phase of the anchor', () => {
    const p = L.hitPieces(0, BAR, [[0, BAR], [2 * BAR, 4 * BAR]], B, 1e9);
    expect(p.map((x) => x.startTick / BAR)).toEqual([0, 2, 3]);
  });
});

describe('search', () => {
  const m = (q, name) => L.matches(name, L.parseQuery(q));
  it('spaces mean all words', () => {
    expect(m('kick 808', '808 Kick Hard.wav')).toBe(true);
    expect(m('kick 808', 'Kick Acoustic.wav')).toBe(false);
  });
  it('OR and | give alternatives', () => {
    expect(m('kick OR snare', 'Snare Tight.wav')).toBe(true);
    expect(m('kick | snare', 'Kick.wav')).toBe(true);
    expect(m('kick OR snare', 'Hat.wav')).toBe(false);
  });
  it('-word excludes', () => {
    expect(m('kick -out', 'Kick In.wav')).toBe(true);
    expect(m('kick -out', 'Kick Out.wav')).toBe(false);
    expect(m('-loop', 'one shot.wav')).toBe(true);
  });
  it('quotes keep a phrase together', () => {
    expect(m('"drum loop"', 'Big Drum Loop 120.wav')).toBe(true);
    expect(m('"drum loop"', 'Drum fill loop.wav')).toBe(false);
  });
  it('an empty search matches everything', () => expect(m('  ', 'x.wav')).toBe(true));
});

describe('ignored folders', () => {
  const words = L.ignoreWords('old, _bak  presets');
  it('checks folder names, not the file name', () => {
    expect(L.inIgnoredFolder('Drums/Old Kits/kick.wav', words)).toBe(true);
    expect(L.inIgnoredFolder('Drums/kick old school.wav', words)).toBe(false);
    expect(L.inIgnoredFolder('kick.wav', words)).toBe(false);
  });
});

describe('sorting', () => {
  const e = (name) => ({ name, path: `/s/${name}`, isDirectory: false });
  const files = [e('a.wav'), e('b.aif'), e('c.wav')];
  const dir = { name: 'Folder', path: '/s/Folder', isDirectory: true };
  const stats = { '/s/b.aif': { stars: 4 }, '/s/c.wav': { stars: 2, adds: 2 }, '/s/a.wav': { plays: 5 } };
  it('keeps folders first and sorts files', () => {
    expect(L.sortEntries([...files, dir], 'rating', stats).map((x) => x.name)).toEqual(['Folder', 'b.aif', 'c.wav', 'a.wav']);
    expect(L.sortEntries(files, 'used', stats).map((x) => x.name)).toEqual(['c.wav', 'a.wav', 'b.aif']); // 2 adds = 6 > 5 plays
    expect(L.sortEntries(files, 'type', stats).map((x) => x.name)).toEqual(['b.aif', 'a.wav', 'c.wav']);
    expect(L.sortEntries(files, 'name', stats)).toEqual(files);
  });
});

async function connected() {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks: ['Drums'] });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  return { engine, luna, session };
}

describe('bar positions through the tempo map', () => {
  it('next bar skips one when the downbeat is too close', async () => {
    const { session } = await connected();
    const tl = session.musical.timeline;
    const bar = (n) => tl.tickAt({ bar: n });
    expect(L.nextBarTick(tl, bar(1))).toBe(bar(2));
    expect(L.nextBarTick(tl, bar(2) - Luna.TICKS_PER_BEAT / 8)).toBe(bar(3)); // 1/32 note before bar 2
    expect(L.barStartTick(tl, bar(3) + Luna.TICKS_PER_BEAT)).toBe(bar(3));
  });
});

describe('listing past LUNA’s limit', () => {
  // A fake disk: listAll lists depth first and stops after `limit` entries, as LUNA does.
  const tree = {
    'a.wav': 1,
    Alpha: { 'k1.wav': 1, 'k2.wav': 1, Sub: { 's1.wav': 1, 's2.wav': 1, 's3.wav': 1 } },
    Beta: { 'b1.wav': 1, Deep: { D2: { 'd1.wav': 1, 'd2.wav': 1, 'd3.wav': 1, 'd4.wav': 1 } } },
    'm.wav': 1,
    Oliver: { 'OLIVER_1.wav': 1, 'OLIVER_2.wav': 1, 'OLIVER_3.wav': 1 },
    'z.wav': 1,
  };
  const at = (path) => path.split('/').filter(Boolean).slice(1).reduce((n, k) => n[k], tree);
  const walk = (node, path, rel, out) => {
    for (const name of Object.keys(node)) {
      const isDirectory = typeof node[name] === 'object';
      const r = rel ? `${rel}/${name}` : name;
      out.push({ name, path: `${path}/${name}`, isDirectory, relativePath: r });
      if (isDirectory) walk(node[name], `${path}/${name}`, r, out);
    }
    return out;
  };
  const io = (limit) => {
    const calls = { all: 0 };
    return {
      calls,
      concurrency: 3,
      listAll: async (p) => { calls.all++; const all = walk(at(p), p, '', []); return { files: all.slice(0, limit), truncated: all.length > limit }; },
      listDir: async (p) => Object.keys(at(p)).map((name) => ({ name, path: `${p}/${name}`, isDirectory: typeof at(p)[name] === 'object' })),
    };
  };
  const full = walk(tree, '/root', '', []);

  it('gives back the same as an unlimited listing, in the same order', async () => {
    for (const limit of [1, 2, 3, 5, 8, 13, 100]) {
      const r = await L.listTree('/root', io(limit));
      expect(r.truncated).toBe(false);
      expect(r.files.map((f) => f.relativePath)).toEqual(full.map((f) => f.relativePath));
      expect(r.files.map((f) => f.path)).toEqual(full.map((f) => f.path));
    }
  });

  it('makes one call when nothing is cut off', async () => {
    const x = io(1000);
    await L.listTree('/root', x);
    expect(x.calls.all).toBe(1);
  });

  it('finds files that were past the cut-off', async () => {
    const r = await L.listTree('/root', io(6));
    const q = L.parseQuery('oliver');
    expect(r.files.filter((f) => !f.isDirectory && L.matches(`root/${f.relativePath}`, q)).map((f) => f.name)).toEqual(['OLIVER_1.wav', 'OLIVER_2.wav', 'OLIVER_3.wav']);
  });

  it('leaves out a folder it may not read', async () => {
    const x = io(4);
    const listAll = x.listAll;
    x.listAll = (p) => (p.endsWith('/Beta') ? Promise.reject(Object.assign(new Error('no'), { code: 'uasrv.not_permitted' })) : listAll(p));
    const r = await L.listTree('/root', x);
    expect(r.files.some((f) => f.relativePath.startsWith('Beta/'))).toBe(false);
    expect(r.files.some((f) => f.relativePath === 'Oliver/OLIVER_3.wav')).toBe(true);
  });
});

describe('telling LUNA’s drop apart in the undo list', () => {
  const D = L.DROP_UNDO_NAME, I = L.DETECT_UNDO_NAME;
  it('undoes the drop, with its instrument detection', () => {
    expect(L.dropUndoCount([D])).toBe(1);
    expect(L.dropUndoCount([D, I])).toBe(2);
    expect(L.dropUndoCount(['Preview', D, I])).toBe(2); // earlier entries stay
  });
  it('leaves it alone when anything else came after, or there is no single drop', () => {
    expect(L.dropUndoCount([])).toBeNull();
    expect(L.dropUndoCount(['Preview'])).toBeNull();
    expect(L.dropUndoCount([D, 'Move Clips'])).toBeNull();
    expect(L.dropUndoCount([D, I, 'Rename Track'])).toBeNull();
    expect(L.dropUndoCount([D, D])).toBeNull();
    expect(L.dropUndoCount([I])).toBeNull();
  });
});

describe('one preview job’s transaction at a time', () => {
  // The SDK runs a transaction opened inside another inside it: one that never ends would hide
  // every audition after it (2026-11-26).
  const fakeSession = () => {
    const calls = [];
    return { calls, batching: true, transaction: async (name, fn) => { calls.push(name); return fn(); } };
  };
  it('waits for an open transaction to end instead of running inside it', async () => {
    const s = fakeSession();
    const p = new L.Previewer(null, s);
    const run = p.tx('Preview', async () => 'done', 2000);
    await new Promise((r) => setTimeout(r, 100));
    expect(s.calls).toEqual([]);
    s.batching = false;
    await expect(run).resolves.toBe('done');
    expect(s.calls).toEqual(['Preview']);
  });
  it('gives up rather than nest inside one that never ends', async () => {
    const s = fakeSession();
    const p = new L.Previewer(null, s);
    await expect(p.tx('Preview', async () => 1, 100)).rejects.toThrow(/still finishing/);
    expect(s.calls).toEqual([]);
  });
  it('adds nothing to a playing preview while a sample is dragged out', async () => {
    const p = new L.Previewer(null, fakeSession());
    let queued = 0;
    p.queue = () => { queued++; return Promise.resolve(); };
    p.current = { kind: 'loop', gap: [0, 10], loop: [0, 100], coveredUntil: 0, lengthTicks: 10 };
    p.session.transport = { tick: 50, looping: { value: false } };
    p.held = true;
    await p.extend();
    expect(queued).toBe(0);
    p.held = false;
    p.extend();
    expect(queued).toBe(1);
  });
});

describe('a dropped loop and LUNA’s loop range', () => {
  // placeAt with the engine work stubbed out: what it would insert, on the mock's tempo map.
  async function drop({ looping, range, at, seconds = 2, plan = { kind: 'loop', bpm: 120, bars: 1 }, noted }) {
    const { session } = await connected();
    const tl = session.musical.timeline;
    const bar = (n) => tl.tickAt({ bar: n });
    const transport = { looping: { value: looping }, loopStart: { value: bar(range[0]) }, loopStop: { value: bar(range[1]) } };
    const p = new L.Previewer(null, { musical: session.musical, transport });
    let inserted = null;
    p.source = async () => ({ id: 'src', seconds, length: { value: seconds * 1e9 } });
    p.findTrack = () => null;
    p.newTrackLike = async (name) => ({ name: { value: name } });
    p.tx = async (_name, fn) => fn();
    p.insertPieces = async (_track, _src, pieces) => { inserted = pieces; return pieces.map((_, i) => `c${i}`); };
    const placed = await p.placeAt({ path: '/x/loop.wav', name: 'loop.wav' }, () => plan, { startTick: at(bar, tl), loopsOnBar: true, ...(noted ? { loopRange: noted(bar) } : {}) });
    return { placed, inserted, bar };
  }

  it('fills the whole loop range, in time with its start, when dropped inside it', async () => {
    const { placed, inserted, bar } = await drop({ looping: true, range: [5, 9], at: (bar) => bar(6) + Luna.TICKS_PER_BEAT });
    expect(placed.filledLoop).toEqual([bar(5), bar(9)]);
    expect(inserted[0].startTick).toBe(bar(5));
    expect(inserted.at(-1).stopTick).toBe(bar(9));
    expect(inserted).toHaveLength(4); // a 1-bar loop, 4 bars
  });

  it('adds one pass from the bar when dropped outside the range, or with looping off', async () => {
    for (const [looping, at] of [[true, (bar) => bar(12) + Luna.TICKS_PER_BEAT], [false, (bar) => bar(6) + Luna.TICKS_PER_BEAT]]) {
      const { placed, inserted, bar } = await drop({ looping, range: [5, 9], at });
      expect(placed.filledLoop).toBeNull();
      expect(inserted).toHaveLength(1);
      expect(inserted[0].startTick).toBe(at(bar) - Luna.TICKS_PER_BEAT);
    }
  });

  it('fills the range noted before the drag, after LUNA moved its own range onto the drop', async () => {
    // LUNA's range now covers just its dropped clip (bar 6 to 7); the range set before was bar 5 to 9.
    const { placed, inserted, bar } = await drop({ looping: true, range: [6, 7], at: (bar) => bar(6), noted: (bar) => [bar(5), bar(9)] });
    expect(placed.filledLoop).toEqual([bar(5), bar(9)]);
    expect(inserted).toHaveLength(4);
    const none = await drop({ looping: true, range: [6, 7], at: (bar) => bar(6), noted: () => null });
    expect(none.placed.filledLoop).toBeNull(); // no range before the drag: one pass, whatever LUNA did
    expect(none.inserted).toHaveLength(1);
  });

  it('plays a one-shot once where it was dropped, even inside the range', async () => {
    const { placed, inserted, bar } = await drop({ looping: true, range: [5, 9], at: (bar) => bar(6) + Luna.TICKS_PER_BEAT, seconds: 0.4, plan: { kind: 'oneshot' } });
    expect(placed.filledLoop).toBeNull();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].startTick).toBe(bar(6) + Luna.TICKS_PER_BEAT);
  });
});

describe('clip positions LUNA accepts', () => {
  it('rounds every tick and nanosecond to a whole number', async () => {
    // LUNA refused a one-shot ending at tick 3576248163215.9995 (2026-11-26).
    const sent = [];
    const p = new L.Previewer(null, { insertClip: async (o) => { sent.push(o); return { id: `c${sent.length}` }; } });
    await p.insertPieces({ id: 't' }, 's', [{ startTick: 3456000000000, stopTick: 3576248163215.9995, sourceStartNs: 0.4, sourceStopNs: 835056689.0000001 }], 'time', 'razor_blade');
    const o = sent[0];
    for (const k of ['startTick', 'stopTick', 'sourceStartNs', 'sourceStopNs']) expect(Number.isInteger(o[k])).toBe(true);
    expect(o.stopTick).toBe(3576248163216);
  });
});

describe('a drop that fails to add', () => {
  it('takes away the new track it made, and says why', async () => {
    const { session } = await connected();
    let undid = 0, uid = 'before';
    const fake = { musical: session.musical, path: '/sessions/x', transport: { looping: { value: false } }, undo: async (n) => { undid += n; } };
    const luna = { raw: { get: async () => ({ properties: { undo_uid: uid } }) } };
    const p = new L.Previewer(luna, fake);
    p.source = async () => ({ id: 'src', seconds: 0.5, length: { value: 5e8 } });
    p.findTrack = () => null;
    p.newTrackLike = async (name) => { uid = 'new-track'; return { name: { value: name } }; };
    p.tx = async () => { throw Object.assign(new Error('refused'), { code: 'uasrv.invalid_property' }); };
    await expect(p.placeAt({ path: '/x/hit.wav', name: 'hit.wav' }, () => ({ kind: 'oneshot' }), { startTick: 0 })).rejects.toThrow('refused');
    expect(undid).toBe(1);
    // …but not when something else has come into the undo list meanwhile
    undid = 0;
    p.newTrackLike = async (name) => { uid = 'new-track'; return { name: { value: name } }; };
    p.tx = async () => { uid = 'someone-else'; throw new Error('refused'); };
    await expect(p.placeAt({ path: '/x/hit.wav', name: 'hit.wav' }, () => ({ kind: 'oneshot' }), { startTick: 0 })).rejects.toThrow();
    expect(undid).toBe(0);
  });
});

describe('the waveform outline', () => {
  it('takes the lowest and highest sample of each span, across channels', () => {
    const left = new Float32Array([0.5, -0.2, 0, 0, 0.1, 0.9, 0, 0]);
    const right = new Float32Array([0, -0.7, 0, 0, 0, 0, -0.3, 0]);
    const { min, max } = L.wavePeaks([left, right], 4);
    expect(Array.from(max).map((v) => +v.toFixed(2))).toEqual([0.5, 0, 0.9, 0]);
    expect(Array.from(min).map((v) => +v.toFixed(2))).toEqual([-0.7, 0, 0, -0.3]);
  });
  it('keeps silence on the zero line and copes with more columns than samples', () => {
    const { min, max } = L.wavePeaks([new Float32Array([0.25, 0.25])], 6);
    expect(min.every((v) => v === 0)).toBe(true); // every span starts from 0
    expect(Array.from(max)).toEqual([0.25, 0.25, 0.25, 0.25, 0.25, 0.25]);
    expect(L.wavePeaks([new Float32Array(0)], 4).max).toHaveLength(4);
  });
});

describe('when a clicked loop comes in while the session plays', () => {
  async function audition(loopStart, here) {
    const { session } = await connected();
    const tl = session.musical.timeline;
    const bar = (n) => tl.tickAt({ bar: n });
    const transport = { playing: { value: true }, tick: here(bar), playStart: { value: 0 }, looping: { value: false }, loopStart: { value: 0 }, loopStop: { value: 0 } };
    const p = new L.Previewer(null, { musical: session.musical, transport }, { aheadBars: 4 });
    p.loopStart = loopStart;
    let inserted = null, added = null;
    p.track = async () => ({ id: 'preview' });
    p.source = async () => ({ id: 'src', seconds: 2, length: { value: 2e9 } });
    p.clipsOnTrack = async () => [];
    p.tx = async (_name, fn) => fn();
    p.insertPieces = async (_track, _src, pieces) => { if (inserted) added = pieces; else inserted = pieces; return pieces.map((_, i) => `c${i}`); };
    const cur = await p.audition({ path: '/x/loop.wav', name: 'loop.wav' }, () => ({ kind: 'loop', bpm: 120, bars: 1 }));
    return { cur, inserted, bar, p, get added() { return added; } };
  }
  const beat = Luna.TICKS_PER_BEAT;

  it('comes in on the next beat, in phase with its bar', async () => {
    const { cur, inserted, bar } = await audition('beat', (bar) => bar(5) + 1.5 * beat);
    expect(inserted[0].startTick).toBe(bar(5) + 2 * beat);
    expect(inserted[0].sourceStartNs).toBe(1e9); // half-way into the 1-bar loop
    expect(inserted[1].startTick).toBe(bar(6)); // the next pass starts on the bar line
    expect(cur.phaseTick).toBe(bar(5));
    expect((cur.coveredUntil - bar(5)) % (bar(6) - bar(5))).toBe(0); // more copies follow on whole passes
  });

  it('or on the next bar, as before', async () => {
    const { inserted, bar } = await audition('bar', (bar) => bar(5) + 1.5 * beat);
    expect(inserted[0].startTick).toBe(bar(6));
    expect(inserted[0].sourceStartNs).toBe(0);
  });

  it('is added from the bar it came in on', async () => {
    const t = await audition('beat', (bar) => bar(5) + 1.5 * beat);
    t.p.newTrackLike = async (name) => ({ name: { value: name } });
    t.p.trackAlg = async () => 5;
    await t.p.add(null);
    expect(t.added[0].startTick).toBe(t.bar(5));
    expect(t.added[0].sourceStartNs).toBe(0);
  });
});
