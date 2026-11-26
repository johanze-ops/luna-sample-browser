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
// LUNA's undo-list names for a file dropped on its timeline (measured, LUNA 3.1.2, 2026-11-26).
const DROP_UNDO_NAME = 'Drag and Drop';
const DETECT_UNDO_NAME = 'Apply Instrument Detection to Tracks';

const AddOnLogic = {
  AUDIO_EXT,
  ONE_SHOT_MAX_SECONDS,
  PREVIEW_TRACK_NAME,
  DROP_UNDO_NAME,
  DETECT_UNDO_NAME,

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
   * A waveform's outline: the decoded `channels` (Float32Arrays, -1..1) cut into `columns`
   * equal spans, each with the lowest and highest sample across all channels. Every span
   * starts from 0, so silence draws on the zero line, as LUNA draws its own. Returns
   * { min, max }, two Float32Arrays of `columns`.
   */
  wavePeaks(channels, columns) {
    const min = new Float32Array(columns), max = new Float32Array(columns);
    const n = channels[0]?.length ?? 0;
    if (!n || columns < 1) return { min, max };
    for (let c = 0; c < columns; c++) {
      const from = Math.floor((c * n) / columns), to = Math.max(from + 1, Math.floor(((c + 1) * n) / columns));
      let lo = 0, hi = 0;
      for (const ch of channels) {
        for (let i = from; i < to && i < n; i++) {
          const v = ch[i];
          if (v < lo) lo = v; else if (v > hi) hi = v;
        }
      }
      min[c] = lo;
      max[c] = hi;
    }
    return { min, max };
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

  /**
   * A one-shot struck at every `interval` from `anchor`, inside `ranges`, unwarped: each hit
   * is `hitTicks` long (the file at the session tempo), cut short by the next hit or the end
   * of its range. A hit whose start falls outside every range is left out.
   */
  hitPieces(anchor, interval, ranges, hitTicks, sourceNs) {
    const pieces = [];
    if (!(interval > 0) || !(hitTicks > 0)) return pieces;
    for (const [a, b] of ranges) {
      if (!(b > a)) continue;
      for (let k = Math.ceil((a - anchor) / interval), s = anchor + k * interval; s < b && pieces.length < 512; k++, s = anchor + k * interval) {
        const len = Math.min(hitTicks, interval, b - s);
        pieces.push({ startTick: s, stopTick: s + len, sourceStartNs: 0, sourceStopNs: Math.round((sourceNs * len) / hitTicks) });
      }
    }
    return pieces;
  },

  /** The start of the beat `tick` is in. */
  beatStartTick(timeline, tick) {
    const b = timeline.barBeat(tick);
    return timeline.tickAt({ bar: b.bar, beat: b.beat });
  },

  /** The downbeat of the bar `tick` is in. */
  barStartTick(timeline, tick) {
    return timeline.tickAt({ bar: timeline.barBeat(tick).bar });
  },

  /**
   * Parse a search: spaces mean AND, `OR` or `|` between terms gives alternatives, `-word`
   * excludes, and "quoted words" match as one phrase. Case is ignored.
   *   kick 808          -> files with both
   *   kick OR snare     -> files with either
   *   kick -out         -> kicks without "out"
   * Returns { alts: [[term, ...], ...], none: [term, ...] }.
   */
  parseQuery(q) {
    const tokens = String(q ?? '').toLowerCase().match(/-?"[^"]*"|\S+/g) ?? [];
    const alts = [[]];
    const none = [];
    for (let tok of tokens) {
      if (tok === 'or' || tok === '|') { if (alts.at(-1).length) alts.push([]); continue; }
      const neg = tok.startsWith('-') && tok.length > 1;
      if (neg) tok = tok.slice(1);
      tok = tok.replace(/^"|"$/g, '');
      if (!tok) continue;
      (neg ? none : alts.at(-1)).push(tok);
    }
    return { alts: alts.filter((a) => a.length), none };
  },

  /** Does `text` match a parsed query? An empty query matches everything. */
  matches(text, query) {
    const t = String(text ?? '').toLowerCase();
    if (query.none.some((w) => t.includes(w))) return false;
    if (!query.alts.length) return true;
    return query.alts.some((all) => all.every((w) => t.includes(w)));
  },

  /**
   * Everything below `folder`, past LUNA's listing limit. `io.listAll` is luna.gui.listAllFiles
   * and `io.listDir` luna.gui.listFiles. listAllFiles stops at 10,000 entries (or 5 s) and
   * lists depth first, so what it returned is a prefix: every top-level entry it got to is
   * complete except the last one, if that is a folder. Keep those, then list the rest one
   * folder at a time (a few at once), splitting again wherever a folder is still too big.
   * A folder that can't be listed (a link out of the blessed folders) is left out.
   * Returns { files, truncated } like listAllFiles; truncated only if it ran out of depth.
   */
  async listTree(folder, io, depth = 0) {
    const { files, truncated } = await io.listAll(folder);
    if (!truncated || depth >= 40) return { files, truncated };
    const top = files.filter((f) => !f.relativePath.includes('/'));
    const done = new Set(top.map((f) => f.name));
    if (top.at(-1)?.isDirectory) done.delete(top.at(-1).name);
    const kept = files.filter((f) => done.has(f.relativePath.split('/')[0]));
    const rest = (await io.listDir(folder)).filter((c) => !done.has(c.name));
    let cut = false;
    const parts = await AddOnLogic.mapLimit(rest, io.concurrency ?? 8, async (c) => {
      const here = [{ ...c, relativePath: c.name }];
      if (!c.isDirectory) return here;
      let sub;
      try { sub = await AddOnLogic.listTree(c.path, io, depth + 1); } catch { return here; }
      cut ||= sub.truncated;
      return here.concat(sub.files.map((f) => ({ ...f, relativePath: `${c.name}/${f.relativePath}` })));
    });
    return { files: kept.concat(...parts), truncated: cut };
  },

  /**
   * After a sample was dragged onto LUNA's timeline: how many of the newest undo entries are
   * LUNA's drop, so undoing them takes exactly the drop back. `names` are the entries made
   * since the drag started, oldest first. LUNA's drop is one "Drag and Drop", followed by an
   * "Apply Instrument Detection to Tracks" when it analysed a fresh import. Entries before the
   * drop are fine (they stay); anything after it, or a second drop, gives null: leave it alone.
   */
  dropUndoCount(names) {
    const drops = names.flatMap((n, i) => (n === DROP_UNDO_NAME ? [i] : []));
    if (drops.length !== 1) return null;
    const after = names.slice(drops[0] + 1);
    return after.every((n) => n === DETECT_UNDO_NAME) ? after.length + 1 : null;
  },

  /** `fn` over `items`, at most `limit` at a time, answers in the items' order. */
  async mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return out;
  },

  /** Words from the "ignore folders" setting: comma or space separated. */
  ignoreWords(setting) {
    return String(setting ?? '').toLowerCase().split(/[,\s]+/).map((w) => w.trim()).filter(Boolean);
  },

  /** True when any folder in `relativePath` (not the file name) contains an ignored word. */
  inIgnoredFolder(relativePath, words) {
    if (!words.length) return false;
    const folders = String(relativePath ?? '').toLowerCase().split('/').slice(0, -1);
    return folders.some((f) => words.some((w) => f.includes(w)));
  },

  /** How much a file has been used: adding it counts more than auditioning it. */
  usage(stat) {
    return stat ? (stat.adds ?? 0) * 3 + (stat.plays ?? 0) : 0;
  },

  /**
   * Sort entries (folders always first, in their own order). `by`: 'name' keeps LUNA's natural
   * order, 'rating' best first, 'used' most used first, 'type' by file type then name.
   */
  sortEntries(entries, by, stats = {}) {
    const dirs = entries.filter((e) => e.isDirectory);
    const files = entries.filter((e) => !e.isDirectory);
    const idx = new Map(files.map((e, i) => [e, i]));
    const ext = (e) => (/\.([^.]+)$/.exec(e.name)?.[1] ?? '').toLowerCase();
    const keyed = {
      rating: (a, b) => (stats[b.path]?.stars ?? 0) - (stats[a.path]?.stars ?? 0),
      used: (a, b) => AddOnLogic.usage(stats[b.path]) - AddOnLogic.usage(stats[a.path]),
      type: (a, b) => ext(a).localeCompare(ext(b)),
    }[by];
    const sorted = keyed ? [...files].sort((a, b) => keyed(a, b) || idx.get(a) - idx.get(b)) : files;
    return [...dirs, ...sorted];
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
    this.loopStart = 'beat'; // while playing, a loop comes in on the next 'beat' or 'bar'
    this.sources = new Map(); // file path -> source uid
    this.clipUids = [];
    this.current = null; // { path, name, plan, startTick, lengthTicks, coveredUntil, kind }
    this.startedTransport = false;
    this.busy = Promise.resolve();
    this.held = false; // true while a sample is being dragged out: the preview adds nothing
  }

  /**
   * A transaction for one job. The SDK runs a transaction opened while another is still open
   * inside that one, and a batch shows nothing until it commits: so if a job given up on by
   * queue() is still holding its batch open, every audition after it would vanish into it.
   * Wait for the open one to finish instead, and fail with an error rather than nest.
   */
  async tx(name, fn, waitMs = 10000) {
    for (let waited = 0; this.session.batching; waited += 25) {
      if (waited >= waitMs) throw new Error('LUNA is still finishing an earlier change');
      await new Promise((r) => setTimeout(r, 25));
    }
    return this.session.transaction(name, fn);
  }

  /** The id of the newest entry in LUNA's undo list (undefined when it can't be read). */
  async undoUid() {
    if (!this.luna?.raw) return undefined;
    const n = await this.luna.raw.get(this.session.path, { children: false, commands: false, propfilter: 'undo_uid', flatvalue: true }).catch(() => null);
    return n?.properties?.undo_uid;
  }

  /**
   * Run engine work one job at a time, so a quick run of clicks cannot interleave. A job that
   * has not finished in 15 s (a request LUNA never answered, a session that went away) is
   * given up on, so it can never block every audition after it.
   */
  queue(fn, timeoutMs = 15000) {
    const guarded = () => Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => setTimeout(() => reject(new Error('LUNA did not answer in time')), timeoutMs)),
    ]);
    const run = this.busy.then(guarded, guarded);
    this.busy = run.catch(() => undefined);
    return run;
  }

  /**
   * Every clip on the Sample Preview track, whoever put it there. The track is the browser's
   * own, so anything on it is a preview: one this page placed, or one saved in the session
   * before LUNA was closed or the page reloaded.
   */
  async clipsOnTrack(track) {
    try {
      const n = await this.luna.raw.get(track.path, { children: false, commands: false, propfilter: 'playlist_uid', flatvalue: true });
      const pl = n?.properties?.playlist_uid;
      if (!pl) return [];
      const c = await this.luna.raw.get(`${this.session.path}/playlists/${pl}/clips`, { levels: 1, properties: false, commands: false });
      return (c?.children ?? []).map((k) => k.path).filter(Boolean);
    } catch { return []; }
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
      // Whole numbers only: LUNA refuses a fractional tick (uasrv.invalid_property), and a
      // one-shot's end from tickAtSeconds can come out as 3576248163215.9995 (2026-11-26).
      const clip = await this.session.insertClip({
        trackUid: track.id, sourceUid, startTick: Math.round(p.startTick), stopTick: Math.round(p.stopTick), lengthFollows,
        sourceStartNs: Math.round(p.sourceStartNs), sourceStopNs: Math.round(p.sourceStopNs),
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

      // A loop repeats itself, warped; a one-shot repeats unwarped on every bar or beat
      // (oneShotRepeat), so a kick plays in time instead of once at a random moment.
      const repeat = plan.kind === 'oneshot' ? this.oneShotRepeat : null;
      let kind = plan.kind === 'loop' ? 'loop' : repeat && repeat !== 'once' ? 'repeat' : 'once';
      let pieces, lengthTicks = null, hitTicks = null, startTick, loop = null, gap = null, anchor = null;
      const lengthFollows = kind === 'loop' ? 'ticks' : 'time';
      if (kind === 'once') {
        startTick = playing ? AddOnLogic.nextBeatTick(tl, here) : (t.playStart.value ?? here);
        pieces = [{ startTick, stopTick: tl.tickAtSeconds(tl.seconds(startTick) + seconds), sourceStartNs: 0, sourceStopNs: srcNs }];
      } else {
        const from = playing ? here : (t.playStart.value ?? here);
        const onBeat = kind === 'repeat' && repeat === 'beat';
        // While playing, a loop comes in on the next beat (loopStart 'beat') or the next bar. On
        // a beat it joins in phase with its bar, where it would be had it started on the
        // downbeat, so the loop's downbeat still lands on the bar line.
        const beatGrid = onBeat || (kind === 'loop' && playing && this.loopStart === 'beat');
        startTick = beatGrid
          ? (playing ? AddOnLogic.nextBeatTick(tl, here) : AddOnLogic.beatStartTick(tl, from))
          : (playing ? AddOnLogic.nextBarTick(tl, here) : AddOnLogic.barStartTick(tl, from));
        if (kind === 'loop') lengthTicks = AddOnLogic.loopTicks(seconds, plan.bpm, plan.bars);
        else {
          lengthTicks = onBeat ? Luna.TICKS_PER_BEAT : barTicks;
          hitTicks = tl.tickAtSeconds(tl.seconds(startTick) + seconds) - startTick;
        }
        const cutFor = (anchor, ranges) => (kind === 'loop'
          ? AddOnLogic.tilePieces(anchor, lengthTicks, ranges, srcNs)
          : AddOnLogic.hitPieces(anchor, lengthTicks, ranges, hitTicks, srcNs));
        loop = this.loopRange(from);
        if (loop) {
          // LUNA is looping: fill the whole loop range, in phase with its start, so the preview
          // plays every time round. While playing, the bar (or beat) you clicked in waits until
          // the playhead has passed it, so the sample still comes in at the next one.
          const [a, b] = loop;
          startTick = Math.min(startTick, b);
          const cellStart = beatGrid ? AddOnLogic.beatStartTick(tl, here) : AddOnLogic.barStartTick(tl, here);
          gap = playing ? [Math.max(a, cellStart), startTick] : null;
          pieces = cutFor(a, gap ? [[a, gap[0]], [gap[1], b]] : [[a, b]]);
          if (gap && !(gap[1] > gap[0])) gap = null;
        } else {
          // A loop is in phase with the bar it comes in on; the copies end on a whole pass.
          anchor = kind === 'loop' ? AddOnLogic.barStartTick(tl, startTick) : startTick;
          const span = Math.max(2 * lengthTicks, Math.ceil((this.aheadBars * barTicks) / lengthTicks) * lengthTicks);
          const end = anchor + Math.ceil((startTick + span - anchor) / lengthTicks) * lengthTicks;
          pieces = cutFor(anchor, [[startTick, end]]);
        }
      }

      const old = [...new Set([...this.clipUids, ...(await this.clipsOnTrack(track))])];
      this.clipUids = [];
      this.firstClip = null;
      await this.tx('Preview', async () => {
        await this.deleteClips(old);
        this.clipUids = await this.insertPieces(track, src.id, pieces, lengthFollows);
      });
      const phase = anchor ?? startTick; // where a whole pass begins
      const coveredUntil = loop ? loop[1] : (kind === 'once' ? pieces[0].stopTick : phase + Math.ceil((Math.max(...pieces.map((p) => p.stopTick)) - phase) / lengthTicks) * lengthTicks);
      this.current = { path: file.path, name: file.name, sourceUid: src.id, plan, seconds, srcNs, startTick, phaseTick: phase, lengthTicks, hitTicks, coveredUntil, kind, loop, gap };
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
  /** The pieces of the current preview that fall in `ranges`, in phase with `anchor`. */
  cut(cur, anchor, ranges) {
    return cur.kind === 'loop'
      ? AddOnLogic.tilePieces(anchor, cur.lengthTicks, ranges, cur.srcNs)
      : AddOnLogic.hitPieces(anchor, cur.lengthTicks, ranges, cur.hitTicks, cur.srcNs);
  }

  extend() {
    const cur = this.current;
    // Held while a sample is dragged out: a preview entry after LUNA's drop would stop the
    // browser putting the dropped sample right.
    if (!cur || cur.kind === 'once' || this.extending || this.held) return Promise.resolve();
    const follows = cur.kind === 'loop' ? 'ticks' : 'time';
    const t = this.session.transport;
    const tick = t.tick;
    if (cur.gap && (tick >= cur.gap[1] || tick < cur.gap[0])) {
      const gap = cur.gap;
      cur.gap = null;
      this.extending = true;
      return this.queue(async () => {
        if (this.current !== cur) return;
        const track = await this.track();
        const pieces = this.cut(cur, cur.loop[0], [gap]);
        await this.tx('Preview', async () => {
          this.clipUids.push(...(await this.insertPieces(track, cur.sourceUid, pieces, follows)));
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
      const until = cur.coveredUntil + Math.max(1, Math.ceil((this.aheadBars * barTicks) / cur.lengthTicks)) * cur.lengthTicks;
      const pieces = this.cut(cur, cur.coveredUntil, [[cur.coveredUntil, until]]);
      await this.tx('Preview', async () => {
        this.clipUids.push(...(await this.insertPieces(track, cur.sourceUid, pieces, follows)));
      });
      cur.coveredUntil = until;
    }).finally(() => { this.extending = false; });
  }

  /**
   * Stop auditioning: remove the preview clips, and stop the transport if we started it.
   * `onlyOwn` removes just the clips this page placed, leaving anything else on the track
   * (a sample the user just dragged onto it).
   */
  stop({ stopTransport = true, onlyOwn = false } = {}) {
    return this.queue(async () => {
      const track = this.findTrack();
      const others = !onlyOwn && track ? await this.clipsOnTrack(track) : [];
      const uids = [...new Set([...this.clipUids, ...others])];
      this.clipUids = [];
      this.current = null;
      if (uids.length) await this.tx('Preview', () => this.deleteClips(uids));
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
    return this.add(null);
  }

  /** The same as addToSession, onto an existing track (not the Sample Preview track). */
  addToTrack(track) {
    if (!track || track.name.value === PREVIEW_TRACK_NAME) return Promise.reject(new Error('pick a track other than Sample Preview'));
    return this.add(track);
  }

  /**
   * Put `file` ({ path, name }) at `startTick`, as Add would: on `track`, or on a new track
   * with the Sample Preview track's warp mode. A loop gets one pass warped to tempoFor's tempo,
   * or, when LUNA is looping and `startTick` is inside the loop range, fills the whole range in
   * phase with its start (as Add does); a one-shot plays once at its own speed. This replaces
   * a drop onto LUNA's timeline, which gets LUNA's own warp mode and tempo instead. `loopsOnBar`
   * starts a single pass at the start of the bar `startTick` is in (LUNA snaps a drop to its
   * grid, often a beat). `stopPreview` takes the preview's clips away in the same undo step
   * (the transport keeps going). `loopRange` ([start, stop] or null for none) stands in for
   * LUNA's loop range now: a drop moves the range onto the dropped clip, so the caller passes
   * the one noted before the drag. Returns { track, clips, plan, startTick, filledLoop }.
   */
  placeAt(file, tempoFor, { track: target = null, startTick, loopsOnBar = false, stopPreview = false, loopRange } = {}) {
    return this.queue(async () => {
      const tl = this.session.musical.timeline;
      const src = await this.source(file.path);
      const seconds = src.seconds ?? (src.length.value ?? 0) / 1e9;
      const srcNs = src.length.value ?? Math.round(seconds * 1e9);
      const plan = tempoFor(seconds);
      const inside = (r) => (r && startTick >= r[0] && startTick < r[1] ? r : null);
      const loop = plan.kind !== 'loop' ? null : loopRange === undefined ? this.loopRange(startTick) : inside(loopRange);
      if (loop) startTick = loop[0];
      else if (loopsOnBar && plan.kind === 'loop') startTick = AddOnLogic.barStartTick(tl, startTick);
      const name = file.name.replace(/\.[^.]+$/, '');
      const preview = this.findTrack();
      const algName = preview ? ALG_TYPES[await this.trackAlg(preview)] : undefined;
      const track = target ?? (await this.newTrackLike(name, algName));
      const madeTrack = target ? null : await this.undoUid(); // the "New Track" entry, if any
      const lengthTicks = plan.kind === 'loop' ? AddOnLogic.loopTicks(seconds, plan.bpm, plan.bars) : 0;
      const pieces = loop
        ? AddOnLogic.tilePieces(loop[0], lengthTicks, [loop], srcNs)
        : plan.kind === 'loop'
          ? this.passes(startTick, lengthTicks, 1, srcNs)
          : [{ startTick, stopTick: tl.tickAtSeconds(tl.seconds(startTick) + seconds), sourceStartNs: 0, sourceStopNs: srcNs }];
      for (const p of pieces) p.name = name;
      const keepFirst = this.firstClip;
      let uids;
      const previews = stopPreview ? this.clipUids : [];
      try {
        await this.tx('Add Sample', async () => {
          await this.deleteClips(previews);
          uids = await this.insertPieces(track, src.id, pieces, plan.kind === 'loop' ? 'ticks' : 'time', algName);
        });
      } catch (err) {
        // Don't leave an empty new track behind: undo it while it is still the newest entry.
        if (madeTrack && (await this.undoUid()) === madeTrack) await this.session.undo(1).catch(() => undefined);
        throw err;
      }
      this.firstClip = keepFirst;
      if (stopPreview) {
        this.clipUids = [];
        this.current = null;
        this.firstClip = null;
        this.startedTransport = false; // as stop({ stopTransport: false })
      }
      return { track, clips: uids.length, plan, startTick, filledLoop: loop };
    });
  }

  add(target) {
    return this.queue(async () => {
      const cur = this.current;
      if (!cur) return null;
      const tl = this.session.musical.timeline;
      const name = cur.name.replace(/\.[^.]+$/, '');
      const alg = await this.trackAlg(await this.track());
      const algName = ALG_TYPES[alg];
      const track = target ?? (await this.newTrackLike(name, algName));
      let pieces;
      const loop = cur.kind === 'loop' ? (this.loopRange(cur.startTick) ?? (cur.loop && this.session.transport.looping.value ? cur.loop : null)) : null;
      if (loop) pieces = AddOnLogic.tilePieces(loop[0], cur.lengthTicks, [loop], cur.srcNs);
      else if (cur.kind === 'loop') pieces = this.passes(cur.phaseTick ?? cur.startTick, cur.lengthTicks, 1, cur.srcNs); // from the bar it came in on
      else pieces = [{ startTick: cur.startTick, stopTick: tl.tickAtSeconds(tl.seconds(cur.startTick) + cur.seconds), sourceStartNs: 0, sourceStopNs: cur.srcNs }];
      for (const p of pieces) p.name = name;
      const keepFirst = this.firstClip;
      let uids;
      await this.tx('Add Sample', async () => {
        uids = await this.insertPieces(track, cur.sourceUid, pieces, cur.kind === 'loop' ? 'ticks' : 'time', algName);
      });
      this.firstClip = keepFirst;
      return { track, clips: uids.length, filledLoop: !!loop };
    });
  }
}

AddOnLogic.Previewer = Previewer;
globalThis.AddOnLogic = AddOnLogic;
