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
