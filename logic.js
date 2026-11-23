// Sample Browser: logic with no DOM, so the tests can run it against Luna.MockEngine.
//
// Two halves:
//   - pure helpers: tempo from a file name, folding a detected tempo into a range, loop maths
//   - Previewer: puts the auditioned sample on a "Sample Preview" track at the next bar, lets
//     LUNA warp it to the session tempo, keeps it looping, and removes it when you move on.

const AUDIO_EXT = /\.(wav|wave|aif|aiff|mp3|m4a|flac|ogg|caf)$/i;
const ONE_SHOT_MAX_SECONDS = 1.2; // shorter than this, with no BPM in the name: a one-shot
const PREVIEW_TRACK_NAME = 'Sample Preview';
// LUNA's warp modes: a track stores the index, a clip the name (track 5 <-> clip 'razor_blade', measured).
const ALG_TYPES = ['polyphonic', 'monophonic', 'efficient', 'soloist', 'varispeed', 'razor_blade', 'ua_stretch', 'clip_effect'];

const AddOnLogic = {
  AUDIO_EXT,
  ONE_SHOT_MAX_SECONDS,
  PREVIEW_TRACK_NAME,

  isAudio(name) {
    return AUDIO_EXT.test(name ?? '');
  },

  /** A BPM written in the file name: "076bpmPINKO", "Loop 120 BPM", "drums_bpm95", "128-bpm". */
  nameBpm(name) {
    const base = String(name ?? '').replace(/\.[^.]+$/, '');
    const m = /(?:^|[^0-9.])(\d{2,3}(?:\.\d+)?)\s*[-_ ]?\s*bpm/i.exec(base) ?? /bpm\s*[-_ ]?\s*(\d{2,3}(?:\.\d+)?)(?![0-9])/i.exec(base);
    if (!m) return null;
    const bpm = Number(m[1]);
    return bpm >= 40 && bpm <= 250 ? bpm : null;
  },

  /** Double or halve `bpm` until it sits in [lo, hi). Detectors often report half-time. */
  fold(bpm, lo = 75, hi = 150) {
    if (!(bpm > 0) || !(lo > 0) || !(hi > lo)) return bpm;
    let b = bpm;
    for (let i = 0; i < 8 && b < lo; i++) b *= 2;
    for (let i = 0; i < 8 && b >= hi; i++) b /= 2;
    return b;
  },

  /** How many bars of `beatsPerBar` a file is at `bpm`, or null when it is not a whole number. */
  wholeBars(seconds, bpm, beatsPerBar = 4) {
    if (!(seconds > 0) || !(bpm > 0)) return null;
    const bars = (seconds * bpm) / (60 * beatsPerBar);
    const r = Math.round(bars);
    const barSeconds = (60 * beatsPerBar) / bpm;
    return r >= 1 && Math.abs(bars - r) * barSeconds < 0.03 ? r : null;
  },

  /** A tempo from the length alone: the whole-bar count (1-32) that lands in the range. */
  lengthBpm(seconds, lo = 75, hi = 150, beatsPerBar = 4) {
    if (!(seconds > 0)) return null;
    for (const bars of [1, 2, 4, 8, 16, 32]) {
      const bpm = (bars * beatsPerBar * 60) / seconds;
      if (bpm >= lo && bpm < hi) return bpm;
    }
    return null;
  },

  /**
   * Decide how to audition a file.
   *   override: a tempo the user set for this file (the 1/2x and 2x buttons, or typed)
   *   detected: LUNA's calculate_tempo result, or null
   * Returns { kind: 'loop' | 'oneshot', bpm, source, bars }.
   */
  resolveTempo({ name, seconds, detected = null, override = null, range = [75, 150], beatsPerBar = 4 }) {
    const [lo, hi] = range;
    const fromName = AddOnLogic.nameBpm(name);
    const pick = (bpm, source) => ({ kind: 'loop', bpm, source, bars: AddOnLogic.wholeBars(seconds, bpm, beatsPerBar) });
    if (override > 0) return pick(override, 'set');
    if (fromName) return pick(fromName, 'name');
    if (seconds > 0 && seconds < ONE_SHOT_MAX_SECONDS) return { kind: 'oneshot', bpm: null, source: null, bars: null };
    if (detected > 0) {
      const folded = AddOnLogic.fold(detected, lo, hi);
      // Prefer the octave of the detected tempo that gives whole bars, if there is one in range.
      for (const b of [folded, folded * 2, folded / 2]) {
        if (b >= lo && b < hi && AddOnLogic.wholeBars(seconds, b, beatsPerBar)) return pick(b, 'luna');
      }
      return pick(folded, 'luna');
    }
    const fromLength = AddOnLogic.lengthBpm(seconds, lo, hi, beatsPerBar);
    if (fromLength) return pick(fromLength, 'length');
    return { kind: 'oneshot', bpm: null, source: null, bars: null };
  },

  /** Short label for a tempo source. */
  sourceLabel(source) {
    return { set: 'set', name: 'name', luna: 'LUNA', length: 'length' }[source] ?? '';
  },

  /**
   * Length of one pass of a loop on the timeline, in ticks. Ticks are musical, so this holds at
   * any session tempo. A whole-bar loop snaps to exactly that many bars (of 4 beats, as
   * resolveTempo counted them), so back-to-back copies never drift off the grid.
   */
  loopTicks(seconds, bpm, bars = null, beatsPerBar = 4) {
    if (bars) return bars * beatsPerBar * Luna.TICKS_PER_BEAT;
    return Math.round(((seconds * bpm) / 60) * Luna.TICKS_PER_BEAT);
  },

  /** Back-to-back [start, stop] spans from `from` until at least `until`. */
  loopSpans(from, lengthTicks, until) {
    const spans = [];
    if (!(lengthTicks > 0)) return spans;
    for (let s = from; s < until || spans.length === 0; s += lengthTicks) {
      spans.push([s, s + lengthTicks]);
      if (spans.length > 512) break;
    }
    return spans;
  },

  /**
   * The loop laid end to end from `anchor`, cut to the `ranges` ([start, stop) in ticks) it may
   * occupy. A piece cut from the middle of a pass says where in the file it starts and stops, so
   * the pattern stays in phase with `anchor` however it is cut.
   * Returns [{ startTick, stopTick, sourceStartNs, sourceStopNs }].
   */
  tilePieces(anchor, lengthTicks, ranges, sourceNs) {
    const pieces = [];
    if (!(lengthTicks > 0)) return pieces;
    const nsPerTick = sourceNs / lengthTicks;
    for (const [a, b] of ranges) {
      if (!(b > a)) continue;
      let k = Math.floor((a - anchor) / lengthTicks);
      for (let ts = anchor + k * lengthTicks; ts < b && pieces.length < 512; k++, ts = anchor + k * lengthTicks) {
        const te = ts + lengthTicks;
        const s = Math.max(ts, a), e = Math.min(te, b);
        if (e <= s) continue;
        pieces.push({
          startTick: s, stopTick: e,
          sourceStartNs: Math.round((s - ts) * nsPerTick),
          sourceStopNs: Math.round((e - ts) * nsPerTick),
        });
      }
    }
    return pieces;
  },

  /** The downbeat of the bar after `tick`, skipping one more bar when that is under `minLeadSec` away. */
  nextBarTick(timeline, tick, minLeadSec = 0.3) {
    let bar = timeline.barBeat(tick).bar + 1;
    let at = timeline.tickAt({ bar });
    if (timeline.seconds(at) - timeline.seconds(tick) < minLeadSec) at = timeline.tickAt({ bar: bar + 1 });
    return at;
  },

  /** The next beat after `tick`, for one-shots while playing. */
  nextBeatTick(timeline, tick, minLeadSec = 0.15) {
    const b = timeline.barBeat(tick);
    let at = timeline.tickAt({ bar: b.bar, beat: b.beat + 1 });
    if (timeline.seconds(at) - timeline.seconds(tick) < minLeadSec) at = timeline.tickAt({ bar: b.bar, beat: b.beat + 2 });
    return at;
  },

  /** The downbeat of the bar `tick` is in. */
  barStartTick(timeline, tick) {
    return timeline.tickAt({ bar: timeline.barBeat(tick).bar });
  },

  /** LUNA's own tempo analysis of a file (undocumented engine command; null if unavailable). */
  async detectTempo(luna, path) {
    try {
      const reply = await luna.raw.post('/analysis/calculate_tempo', { path });
      const bpm = Number(reply?.tempo);
      return bpm > 0 ? bpm : null;
    } catch {
      return null;
    }
  },
};

/**
 * Auditions samples on a dedicated track, through LUNA's mixer, warped by LUNA's engine.
 * Every audition is one undo entry ("Preview"), stopping is one more.
 */
class Previewer {
  constructor(luna, session, { aheadBars = 32 } = {}) {
    this.luna = luna;
    this.session = session;
    this.aheadBars = aheadBars;
    this.sources = new Map(); // file path -> source uid
    this.clipUids = [];
    this.current = null; // { path, name, plan, startTick, lengthTicks, coveredUntil, kind }
    this.startedTransport = false;
    this.busy = Promise.resolve();
  }

  /** Run engine work one job at a time, so a quick run of clicks cannot interleave. */
  queue(fn) {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => undefined);
    return run;
  }

  findTrack() {
    return this.session.tracks.items.find((t) => t.name.value === PREVIEW_TRACK_NAME);
  }

  async track() {
    let track = this.findTrack();
    if (!track) {
      [track] = await this.session.newTrack({ name: PREVIEW_TRACK_NAME, stemFormat: 'stereo' });
      // Follow tempo, so the preview stays musical if the session tempo changes.
      try { await track.property('follows').set('ticks'); } catch { /* older LUNA: leave it */ }
    }
    return track;
  }

  async source(path) {
    const known = this.sources.get(path);
    if (known && this.session.sources?.byId?.(known)) return this.session.sources.byId(known);
    const src = await this.session.importPath(path);
    this.sources.set(path, src.id);
    return src;
  }

  /** Delete clips by uid without waiting for each to settle (safe inside a batch transaction). */
  async deleteClips(uids) {
    for (const uid of uids) {
      await this.luna.raw.post(`${this.session.path}/delete_clip`, { session_uid: this.session.id, uid }).catch(() => undefined);
    }
  }

  /**
   * Insert clips. Every piece says which part of the file it plays (sourceStartNs-sourceStopNs):
   * without that LUNA stores a zero-length source range, which plays but draws no waveform.
   */
  async insertPieces(track, sourceUid, pieces, lengthFollows, algType) {
    const uids = [];
    for (const p of pieces) {
      const clip = await this.session.insertClip({
        trackUid: track.id, sourceUid, startTick: p.startTick, stopTick: p.stopTick, lengthFollows,
        sourceStartNs: p.sourceStartNs, sourceStopNs: p.sourceStopNs,
        ...(algType ? { algType } : {}),
        ...(p.name ? { name: p.name } : {}),
      });
      if (!this.firstClip) this.firstClip = clip;
      uids.push(clip.id);
    }
    return uids;
  }

  /** A track's warp mode, as LUNA stores it on the track (a number; -1 = not set). */
  async trackAlg(track) {
    try {
      const n = await this.luna.raw.get(track.path, { children: false, commands: false, propfilter: 'alg_type', flatvalue: true });
      const v = n?.properties?.alg_type;
      return typeof v === 'number' ? v : -1;
    } catch { return -1; }
  }

  /**
   * A new stereo track that follows tempo, with warp mode `algName` ('razor_blade', ...).
   * A track's warp mode can only be given when it is created (LUNA refuses a later write), and
   * only by name, so this calls LUNA's new_track itself. Resolves once the track is listed.
   */
  async newTrackLike(name, algName) {
    const s = this.session;
    const payload = { uid: s.id, name, stem_format: 'stereo', follows: 'ticks', make_name_unique: true, ...(algName ? { alg_type: algName } : {}) };
    const reply = await this.luna.raw.post(`${s.path}/new_track`, payload);
    const uid = reply?.uid;
    for (let i = 0; i < 100; i++) {
      const t = uid && s.tracks.byId(uid);
      if (t && t.name.value !== undefined) return t;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('the new track did not appear');
  }

  /** Whole passes of the loop from `from`, `passes` long, each playing the whole file. */
  passes(from, lengthTicks, passes, srcNs) {
    return AddOnLogic.tilePieces(from, lengthTicks, [[from, from + passes * lengthTicks]], srcNs);
  }

  /** LUNA's loop range, when looping is on and `tick` is inside it. */
  loopRange(tick) {
    const t = this.session.transport;
    const a = t.loopStart.value, b = t.loopStop.value;
    return t.looping.value === true && b > a && tick >= a && tick < b ? [a, b] : null;
  }

  /** Wait (briefly) for LUNA to finish warping the first clip, so playback doesn't start on silence. */
  async waitForRender(maxMs = 1500) {
    const clip = this.firstClip;
    for (let waited = 0; clip && waited < maxMs; waited += 25) {
      if (clip.renderState.value === 'current' || clip.disposed) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * Audition `file` ({ path, name }). `tempo` is resolveTempo()'s answer for it.
   * Plays from the next bar when the session is playing, else from the play start (and starts it).
   */
  audition(file, tempoFor) {
    return this.queue(async () => {
      const t = this.session.transport;
      const tl = this.session.musical.timeline;
      const track = await this.track();
      const src = await this.source(file.path);
      const seconds = src.seconds ?? (src.length.value ?? 0) / 1e9;
      const srcNs = src.length.value ?? Math.round(seconds * 1e9);
      const plan = tempoFor(seconds);
      const playing = t.playing.value === true;
      const here = t.tick;
      const barTicks = tl.tickAt({ bar: 2 }) - tl.tickAt({ bar: 1 });

      let pieces, lengthTicks = null, startTick, lengthFollows, loop = null, gap = null;
      if (plan.kind === 'loop') {
        const from = playing ? here : (t.playStart.value ?? here);
        startTick = playing ? AddOnLogic.nextBarTick(tl, here) : AddOnLogic.barStartTick(tl, from);
        lengthTicks = AddOnLogic.loopTicks(seconds, plan.bpm, plan.bars);
        lengthFollows = 'ticks';
        loop = this.loopRange(from);
        if (loop) {
          // LUNA is looping: fill the whole loop range, in phase with its start, so the preview
          // plays every time round. While playing, the bar you clicked in waits until the
          // playhead has passed it, so the sample still comes in at the next bar.
          const [a, b] = loop;
          startTick = Math.min(startTick, b);
          gap = playing ? [Math.max(a, AddOnLogic.barStartTick(tl, here)), startTick] : null;
          const ranges = gap ? [[a, gap[0]], [gap[1], b]] : [[a, b]];
          pieces = AddOnLogic.tilePieces(a, lengthTicks, ranges, srcNs);
          if (gap && !(gap[1] > gap[0])) gap = null;
        } else {
          pieces = this.passes(startTick, lengthTicks, Math.max(2, Math.ceil((this.aheadBars * barTicks) / lengthTicks)), srcNs);
        }
      } else {
        startTick = playing ? AddOnLogic.nextBeatTick(tl, here) : (t.playStart.value ?? here);
        pieces = [{ startTick, stopTick: tl.tickAtSeconds(tl.seconds(startTick) + seconds), sourceStartNs: 0, sourceStopNs: srcNs }];
        lengthFollows = 'time';
      }

      const old = this.clipUids;
      this.clipUids = [];
      this.firstClip = null;
      await this.session.transaction('Preview', async () => {
        await this.deleteClips(old);
        this.clipUids = await this.insertPieces(track, src.id, pieces, lengthFollows);
      });
      const coveredUntil = loop ? loop[1] : Math.max(...pieces.map((p) => p.stopTick));
      this.current = { path: file.path, name: file.name, sourceUid: src.id, plan, seconds, srcNs, startTick, lengthTicks, coveredUntil, kind: plan.kind, loop, gap };
      if (!playing) {
        if (plan.kind === 'loop') await this.waitForRender();
        await t.play();
        this.startedTransport = true;
      }
      return this.current;
    });
  }

  /**
   * Keep a loop going as the playhead moves: fill the bar that was skipped once the playhead is
   * past it (looping), or add another stretch of copies when the playhead nears the end.
   */
  extend() {
    const cur = this.current;
    if (!cur || cur.kind !== 'loop' || this.extending) return Promise.resolve();
    const t = this.session.transport;
    const tick = t.tick;
    if (cur.gap && (tick >= cur.gap[1] || tick < cur.gap[0])) {
      const gap = cur.gap;
      cur.gap = null;
      this.extending = true;
      return this.queue(async () => {
        if (this.current !== cur) return;
        const track = await this.track();
        const pieces = AddOnLogic.tilePieces(cur.loop[0], cur.lengthTicks, [gap], cur.srcNs);
        await this.session.transaction('Preview', async () => {
          this.clipUids.push(...(await this.insertPieces(track, cur.sourceUid, pieces, 'ticks')));
        });
      }).finally(() => { this.extending = false; });
    }
    if (cur.loop && t.looping.value === true) return Promise.resolve(); // the loop range is covered
    const tl = this.session.musical.timeline;
    const barTicks = tl.tickAt({ bar: 2 }) - tl.tickAt({ bar: 1 });
    if (tick < cur.coveredUntil - 8 * barTicks) return Promise.resolve();
    this.extending = true;
    return this.queue(async () => {
      if (this.current !== cur) return;
      const track = await this.track();
      const pieces = this.passes(cur.coveredUntil, cur.lengthTicks, Math.max(1, Math.ceil((this.aheadBars * barTicks) / cur.lengthTicks)), cur.srcNs);
      await this.session.transaction('Preview', async () => {
        this.clipUids.push(...(await this.insertPieces(track, cur.sourceUid, pieces, 'ticks')));
      });
      cur.coveredUntil = pieces.at(-1).stopTick;
    }).finally(() => { this.extending = false; });
  }

  /** Stop auditioning: remove the preview clips, and stop the transport if we started it. */
  stop({ stopTransport = true } = {}) {
    return this.queue(async () => {
      const uids = this.clipUids;
      this.clipUids = [];
      this.current = null;
      if (uids.length) await this.session.transaction('Preview', () => this.deleteClips(uids));
      if (stopTransport && this.startedTransport && this.session.transport.playing.value) await this.session.transport.stop();
      this.startedTransport = false;
    });
  }

  /**
   * Put the sample being auditioned on a new track of its own, with the Sample Preview track's
   * warp mode. A loop fills LUNA's loop range when looping is on (in phase with its start, as
   * the preview played it), otherwise one pass from the bar the preview started on.
   * Returns { track, clips }.
   */
  addToSession() {
    return this.queue(async () => {
      const cur = this.current;
      if (!cur) return null;
      const tl = this.session.musical.timeline;
      const name = cur.name.replace(/\.[^.]+$/, '');
      const alg = await this.trackAlg(await this.track());
      const algName = ALG_TYPES[alg];
      const track = await this.newTrackLike(name, algName);
      let pieces;
      const loop = cur.kind === 'loop' ? (this.loopRange(cur.startTick) ?? (cur.loop && this.session.transport.looping.value ? cur.loop : null)) : null;
      if (loop) pieces = AddOnLogic.tilePieces(loop[0], cur.lengthTicks, [loop], cur.srcNs);
      else if (cur.kind === 'loop') pieces = this.passes(cur.startTick, cur.lengthTicks, 1, cur.srcNs);
      else pieces = [{ startTick: cur.startTick, stopTick: tl.tickAtSeconds(tl.seconds(cur.startTick) + cur.seconds), sourceStartNs: 0, sourceStopNs: cur.srcNs }];
      for (const p of pieces) p.name = name;
      const keepFirst = this.firstClip;
      let uids;
      await this.session.transaction('Add Sample', async () => {
        uids = await this.insertPieces(track, cur.sourceUid, pieces, cur.kind === 'loop' ? 'ticks' : 'time', algName);
      });
      this.firstClip = keepFirst;
      return { track, clips: uids.length, filledLoop: !!loop };
    });
  }
}

AddOnLogic.Previewer = Previewer;
globalThis.AddOnLogic = AddOnLogic;
