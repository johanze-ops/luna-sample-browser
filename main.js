// Sample Browser: DOM wiring. Browse LUNA's blessed folders, search them, rate samples, and
// audition through the Previewer (logic.js). Per-viewer conveniences (last folder, tempo
// range, tempo fixes, ratings, usage) live in localStorage.

const $ = (id) => document.getElementById(id);
const L = AddOnLogic;
const STORE_KEY = 'com.ranrun.sample_browser';
const COLOURS = [null, 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];
const MAX_ROWS = 1500;

// ---------- per-viewer settings ----------
const prefs = (() => {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { data = {}; }
  data.lo ??= 75; data.hi ??= 150; data.autoplay ??= true;
  data.detected ??= {}; data.overrides ??= {}; data.stats ??= {};
  data.ignore ??= ''; data.sort ??= 'name'; data.scope ??= 'below';
  if (data.scope === 'here') data.scope = 'below'; // searching always includes subfolders now
  data.oneshot ??= 'bar';
  data.skip ??= {}; // added folders left out of "Chosen folders" searches
  let timer = null;
  return {
    data,
    save() {
      clearTimeout(timer);
      timer = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* private mode: fine */ } }, 150);
    },
  };
})();
const P = prefs.data;
const stat = (path) => (P.stats[path] ??= {});

// ---------- state ----------
let luna, session, previewer;
let releases = [];
const keep = (u) => u && releases.push(u);
const release = () => { for (const u of releases) { try { typeof u === 'function' ? u() : (u.dispose ?? u.release ?? u.unbind)?.call(u); } catch { /* gone */ } } releases = []; };
let root = null, cwd = null;
let entries = [];  // what the current folder or search produced, before filters
let shown = [];    // after filters and sorting
let sel = -1;
let volumeBound = false;
let detectRun = 0, listRun = 0;
const deepCache = new Map(); // folder -> { at, files, truncated }

const status = (text) => { $('status').textContent = text; };
const base = (p) => p.replace(/\/+$/, '').split('/').pop();
const parent = (p) => p.replace(/\/+$/, '').replace(/\/[^/]+$/, '') || '/';
const folders = () => luna?.gui.blessedFolders.value ?? [];

// ---------- tempo ----------
function rangeOf() { return [Number(P.lo) || 75, Number(P.hi) || 150]; }

/** What the row shows before the file is imported (no length yet). */
function badgeFor(entry) {
  const o = P.overrides[entry.path];
  if (o) return { bpm: o, src: 'set' };
  const n = L.nameBpm(entry.name);
  if (n) return { bpm: n, src: 'name' };
  const d = P.detected[entry.path];
  if (d === null) return { bpm: null, src: 'none' };
  if (d > 0) { const [lo, hi] = rangeOf(); return { bpm: L.fold(d, lo, hi), src: 'luna' }; }
  return { bpm: undefined, src: 'pending' };
}

/** 'loop', 'oneshot' or 'unknown', from what we know so far. */
function kindOf(entry) {
  const k = P.stats[entry.path]?.kind;
  if (k) return k;
  const src = badgeFor(entry).src;
  return src === 'pending' ? 'unknown' : src === 'none' ? 'oneshot' : 'loop';
}

function badgeHtml(entry) {
  if (entry.isDirectory) return '';
  if (P.stats[entry.path]?.kind === 'oneshot') return '<span title="Plays once, unwarped">1-shot</span>';
  const b = badgeFor(entry);
  if (b.src === 'pending') return '<span title="Asking LUNA for the tempo">…</span>';
  if (b.src === 'none') return '<span title="No tempo found: plays as a one-shot unless it is long enough to guess from its length">—</span>';
  return `<b>${b.bpm.toFixed(b.bpm % 1 ? 1 : 0)}</b> ${L.sourceLabel(b.src)}`;
}

/** Ask LUNA for the tempo of files in view with no BPM in their name, one at a time. */
async function detectInBackground() {
  const run = ++detectRun;
  for (const e of shown.slice(0, 300)) {
    if (run !== detectRun) return;
    if (e.isDirectory || L.nameBpm(e.name) || P.detected[e.path] !== undefined) continue;
    P.detected[e.path] = await L.detectTempo(luna, e.path);
    prefs.save();
    paintRow(e);
  }
}

// ---------- folders ----------
function renderFolders() {
  const list = folders();
  const box = $('folders');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<option value="">No sample folders yet — click + Folder</option>';
    return;
  }
  for (const f of list) {
    const o = document.createElement('option');
    o.value = f; o.textContent = base(f); o.title = f;
    box.appendChild(o);
  }
  if (!root || !list.includes(root)) root = list.includes(P.root) ? P.root : list.at(-1);
  box.value = root;
}

/** The checklist under the search box: which added folders "Chosen folders" searches. */
function renderChooser() {
  const on = $('scope').value === 'all';
  $('choose').hidden = !on;
  if (!on) return;
  const list = folders();
  const box = $('chooseList');
  box.innerHTML = list.length ? '' : '<div class="hint">No folders added yet.</div>';
  for (const f of list) {
    const label = document.createElement('label');
    label.title = f;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !P.skip[f];
    cb.onchange = () => { if (cb.checked) delete P.skip[f]; else P.skip[f] = true; prefs.save(); refresh(); };
    label.append(cb, document.createTextNode(` ${base(f)}`));
    box.appendChild(label);
  }
}

function crumbs() {
  $('crumbs').textContent = !cwd ? '' : cwd === root ? base(root) : `${base(root)} / ${cwd.slice(root.length + 1).split('/').join(' / ')}`;
  $('crumbs').title = cwd ?? '';
  $('up').disabled = !cwd || cwd === root;
}

async function openFolder(path, { keepSel = null } = {}) {
  cwd = path;
  P.cwd = cwd; P.root = root; prefs.save();
  crumbs();
  await refresh({ keepSel });
}

/** Everything below `folder`, cached for a minute (LUNA stops at 10,000 entries). */
async function deepList(folder) {
  const hit = deepCache.get(folder);
  if (hit && Date.now() - hit.at < 60000) return hit;
  const { files, truncated } = await L.listTree(folder, { listAll: (p) => luna.gui.listAllFiles(p), listDir: (p) => luna.gui.listFiles(p) });
  const value = { at: Date.now(), files, truncated };
  deepCache.set(folder, value);
  return value;
}

/** Rebuild `entries` for the current folder, search and scope, then filter and draw. */
async function refresh({ keepSel = null } = {}) {
  const run = ++listRun;
  const q = L.parseQuery($('search').value);
  const searching = q.alts.length || q.none.length;
  const scope = $('scope').value;
  const ignore = L.ignoreWords(P.ignore);
  let note = '';
  try {
    if (!searching && scope !== 'all') { // browsing: just this folder's contents
      if (!cwd) { entries = []; return draw(keepSel); }
      const list = await luna.gui.listFiles(cwd);
      if (run !== listRun) return;
      entries = list
        .filter((e) => (e.isDirectory ? !ignore.some((w) => e.name.toLowerCase().includes(w)) : L.isAudio(e.name)))
        .filter((e) => e.isDirectory || L.matches(e.name, q))
        .map((e) => ({ ...e }));
    } else {
      const tops = scope === 'all' ? folders().filter((f) => !P.skip[f]) : cwd ? [cwd] : [];
      if (!tops.length) { entries = []; status(scope === 'all' ? 'Tick at least one folder to search.' : ''); return draw(keepSel); }
      status(`Searching ${scope === 'all' ? `${tops.length} folder${tops.length > 1 ? 's' : ''}` : base(cwd)}…`);
      const found = [];
      let truncated = false;
      for (const top of tops) {
        const { files, truncated: t } = await deepList(top);
        if (run !== listRun) return;
        truncated ||= t;
        for (const f of files) {
          if (f.isDirectory || !L.isAudio(f.name)) continue;
          const rel = f.relativePath ?? f.name;
          if (L.inIgnoredFolder(rel, ignore)) continue;
          const where = `${base(top)}/${rel}`;
          if (!L.matches(where, q)) continue;
          found.push({ name: f.name, path: f.path, isDirectory: false, sub: where.replace(/\/[^/]*$/, '') });
        }
      }
      entries = found;
      if (truncated) note = ' (some folders are nested too deep to list: search a folder further down for the rest)';
    }
  } catch (e) {
    entries = [];
    status(e.code === 'uasrv.not_permitted' ? `LUNA won't let Add Ons read that folder. Add it with + Folder.` : `Couldn't list files: ${e.code ?? e.message}`);
    return draw(keepSel);
  }
  draw(keepSel);
  if (run === listRun) {
    const files = shown.filter((e) => !e.isDirectory).length;
    status(`${files} sample${files === 1 ? '' : 's'}${note}`);
  }
}

/** Apply the filters and sort to `entries`, then render. */
function draw(keepPath = null) {
  const kind = $('kind').value, minStars = Number($('minStars').value), colour = $('colour').value;
  const pass = (e) => e.isDirectory
    ? kind === 'all' && !minStars && !colour
    : (kind === 'all' || kindOf(e) === kind) && (P.stats[e.path]?.stars ?? 0) >= minStars && (!colour || P.stats[e.path]?.color === colour);
  shown = L.sortEntries(entries.filter(pass), $('sort').value, P.stats);
  sel = keepPath ? shown.findIndex((e) => e.path === keepPath) : (shown[sel]?.path ? sel : -1);
  renderList();
  detectInBackground();
}

async function addFolder() {
  if (!(await luna.gui.available())) return status('Open the Sample Browser inside LUNA to add folders.');
  try {
    const [folder] = await luna.gui.chooseFolders({ title: 'Choose a sample folder' });
    if (folder) await adoptFolder(folder);
  } catch (e) {
    status(`Couldn't open LUNA's folder dialog (${e.code ?? e.message}). Add folders in Settings > Add Ons > FOLDERS, or drop one here.`);
  }
}

/** Make `folder` the root, asking LUNA to allow it if needed. */
async function adoptFolder(folder) {
  const allowed = () => folders().some((f) => folder === f || folder.startsWith(f + '/'));
  if (!allowed()) {
    status(`Allow ${base(folder)} in LUNA's prompt…`);
    try { await luna.gui.addBlessedFolder(folder); } catch (e) { return status(`LUNA refused ${base(folder)} (${e.code ?? e.message}). Pick a folder inside it, not a whole drive or your home folder.`); }
    for (let i = 0; i < 600 && !allowed(); i++) await new Promise((r) => setTimeout(r, 100));
    if (!allowed()) return status(`${base(folder)} wasn't allowed.`);
  }
  root = folders().find((f) => folder === f || folder.startsWith(f + '/'));
  renderFolders();
  await openFolder(folder);
}

// ---------- list ----------
function starsHtml(path) {
  const n = P.stats[path]?.stars ?? 0;
  return `<span class="stars" title="Rating (1-5, 0 clears)">${[1, 2, 3, 4, 5].map((i) => `<span data-star="${i}" class="${i <= n ? '' : 'off'}">★</span>`).join('')}</span>`;
}

function rowHtml(e, i) {
  const playing = previewer?.current?.path === e.path;
  const s = P.stats[e.path];
  const dot = e.isDirectory ? '' : `<span class="dot" data-act="colour" title="Colour (C)" style="background:${s?.color ? `var(--c-${s.color})` : 'transparent'}"></span>`;
  const tools = e.isDirectory ? '' : `<span class="tools"><button data-act="half" title="Half the tempo">½×</button><button data-act="double" title="Double the tempo">2×</button>${P.overrides[e.path] ? '<button data-act="reset" title="Back to the detected tempo">reset</button>' : ''}</span>`;
  const stars = e.isDirectory ? '' : (i === sel || s?.stars ? starsHtml(e.path) : '');
  return `<div class="row${i === sel ? ' sel' : ''}${playing ? ' playing' : ''}" data-i="${i}"${e.isDirectory ? '' : ' draggable="true" title="Drag onto a track in LUNA, or onto empty space for a new track"'}><span class="icon">${e.isDirectory ? '▸' : '♪'}</span><span class="text"><div class="name"></div>${e.sub ? '<div class="sub"></div>' : ''}</span>${dot}${stars}${tools}<span class="bpm">${badgeHtml(e)}</span></div>`;
}

function fillText(row, e) {
  row.querySelector('.name').textContent = e.name;
  const sub = row.querySelector('.sub');
  if (sub) sub.textContent = e.sub;
}

function renderList() {
  const list = $('list');
  if (!shown.length) {
    const searching = $('search').value.trim();
    list.innerHTML = `<div class="empty">${!folders().length ? 'Add a sample folder with <b>+ Folder</b>, or drop one onto this panel.<br>LUNA asks you to allow it the first time.' : searching ? 'Nothing matches here. Try <b>Chosen folders</b>, or loosen the filters.' : 'No audio files or folders here.'}</div>`;
    return;
  }
  const rows = shown.slice(0, MAX_ROWS);
  list.innerHTML = rows.map(rowHtml).join('') + (shown.length > MAX_ROWS ? `<div class="more">Showing the first ${MAX_ROWS} of ${shown.length}. Search to narrow it down.</div>` : '');
  list.querySelectorAll('.row').forEach((row) => fillText(row, shown[Number(row.dataset.i)]));
}

function paintRow(e) {
  const i = shown.indexOf(e);
  const row = $('list').querySelector(`.row[data-i="${i}"]`);
  if (!row) return;
  row.outerHTML = rowHtml(e, i);
  fillText($('list').querySelector(`.row[data-i="${i}"]`), e);
}

function select(i, { play = false } = {}) {
  if (i < 0 || i >= Math.min(shown.length, MAX_ROWS)) return;
  const old = sel;
  sel = i;
  if (shown[old]) paintRow(shown[old]);
  paintRow(shown[i]);
  $('list').querySelector(`.row[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  if (play && !shown[i].isDirectory) audition(shown[i]);
}

// ---------- ratings ----------
function rate(e, stars) {
  if (!e || e.isDirectory) return;
  stat(e.path).stars = stars || undefined;
  prefs.save();
  paintRow(e);
}

function cycleColour(e) {
  if (!e || e.isDirectory) return;
  const s = stat(e.path);
  s.color = COLOURS[(COLOURS.indexOf(s.color ?? null) + 1) % COLOURS.length] ?? undefined;
  prefs.save();
  paintRow(e);
}

// ---------- audition ----------
/** The tempo rule for a file (name, your ½×/2× fix, LUNA's analysis), as resolveTempo's input. */
async function tempoFor(e) {
  const [lo, hi] = rangeOf();
  if (!P.overrides[e.path] && !L.nameBpm(e.name) && P.detected[e.path] === undefined) {
    P.detected[e.path] = await L.detectTempo(luna, e.path);
    prefs.save();
  }
  return (seconds) => L.resolveTempo({ name: e.name, seconds, detected: P.detected[e.path], override: P.overrides[e.path], range: [lo, hi] });
}

async function audition(e) {
  if (!session || !previewer) return status('Open a session in LUNA first.');
  if (dropsPending) { status('Finishing the drop…'); await Promise.race([dropChain, pause(30000)]); }
  previewer.held = false; // a drag that never reported its end must not hold the preview
  const rule = await tempoFor(e);
  const was = previewer.current?.path;
  status(`Loading ${e.name}…`);
  try {
    const cur = await previewer.audition(e, rule);
    const p = cur.plan;
    const s = stat(e.path);
    s.plays = (s.plays ?? 0) + 1;
    s.kind = p.kind;
    prefs.save();
    const bar = session.musical.timeline.barBeat(cur.startTick).bar;
    status(p.kind === 'loop'
      ? `▶ ${e.name} · ${p.bpm.toFixed(1)} BPM (${L.sourceLabel(p.source)})${p.bars ? ` · ${p.bars} bar${p.bars > 1 ? 's' : ''}` : ''} · from bar ${bar}`
      : `▶ ${e.name} · one-shot`);
    bindVolume();
  } catch (err) {
    status(`Couldn't play ${e.name}: ${err.code ?? err.message}`);
  }
  for (const x of shown) if (x.path === was || x.path === e.path) paintRow(x);
}

async function stopPreview() {
  if (!previewer?.current) return;
  const was = previewer.current.path;
  await previewer.stop();
  status('Stopped');
  for (const x of shown) if (x.path === was) paintRow(x);
}

/** Add what's playing (or the selected sample) to a new track, or to LUNA's selected track. */
async function addSample({ toSelected = false } = {}) {
  if (!previewer) return status('Open a session in LUNA first.');
  const e = shown[sel];
  if (!previewer.current || (e && !e.isDirectory && previewer.current.path !== e.path)) {
    if (e && !e.isDirectory) await audition(e); else return status('Pick a sample first.');
  }
  const cur = previewer.current;
  if (!cur) return;
  try {
    let added;
    if (toSelected) {
      const track = session.focusedTrack.value;
      if (!track || track.name.value === L.PREVIEW_TRACK_NAME) return status('Select a track in LUNA first (not Sample Preview).');
      added = await previewer.addToTrack(track);
    } else {
      added = await previewer.addToSession();
    }
    if (!added) return;
    // The sample now plays from its own track: take the preview away so it doesn't double up,
    // but keep the session playing so you hear it in place.
    await previewer.stop({ stopTransport: false });
    for (const x of shown) if (x.path === cur.path) paintRow(x);
    const s = stat(cur.path);
    s.adds = (s.adds ?? 0) + 1;
    prefs.save();
    status(`Added ${cur.name} to “${added.track.name.value ?? ''}”${added.filledLoop ? ` — filled the loop range (${added.clips} clip${added.clips > 1 ? 's' : ''})` : ''}`);
  } catch (err) { status(`Couldn't add ${cur.name}: ${err.code ?? err.message}`); }
}

const DRAG_PICTURE_H = 20;

/** The drag picture: the sample's name on a small tab, with an accent bar on its left edge. */
function dragPicture(name) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = '12px -apple-system, Helvetica, sans-serif';
  ctx.font = font;
  const w = Math.min(260, Math.ceil(ctx.measureText(name).width) + 16);
  c.width = w; c.height = DRAG_PICTURE_H; // resizing clears the context's settings
  ctx.fillStyle = 'rgba(42, 38, 24, 0.92)';
  ctx.fillRect(0, 0, w, DRAG_PICTURE_H);
  ctx.fillStyle = '#F7C449';
  ctx.fillRect(0, 0, 2, DRAG_PICTURE_H);
  ctx.font = font;
  ctx.fillStyle = '#ddd';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, 8, DRAG_PICTURE_H / 2 + 1, w - 12);
  const img = new Image();
  img.src = c.toDataURL();
  return img;
}

// ---------- drag onto LUNA's timeline ----------
// LUNA places a dropped file itself: snapped to a bar, with its own warp mode (a file the preview
// already brought in gets none, shown as Polyphonic) and its own tempo guess. So once LUNA has
// placed it, the browser undoes LUNA's drop and puts the sample there itself, as New track /
// To track would: Sample Preview's warp mode, the browser's tempo, at the bar LUNA chose. It only
// does that when the newest undo entries are exactly LUNA's drop; otherwise it leaves it alone.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function undoUid() {
  const n = await luna.raw.get(session.path, { children: false, commands: false, propfilter: 'undo_uid', flatvalue: true });
  return n?.properties?.undo_uid;
}

/** LUNA's undo list, oldest first: [{ rowid, uid, name }]. */
async function undoEntries() {
  // levels: 2, or LUNA leaves out the entries' properties (measured 2026-11-26).
  const q = await luna.raw.get(`${session.path}/undo_queues`, { levels: 2, properties: true, commands: false, propfilter: ['rowid', 'uid', 'name'], flatvalue: true });
  return (q?.children ?? []).map((c) => c.properties ?? {}).filter((p) => typeof p.rowid === 'number').sort((x, y) => x.rowid - y.rowid);
}

/** Paths of the clips on a track's current playlist. */
async function clipPaths(track) {
  const n = await luna.raw.get(track.path, { children: false, commands: false, propfilter: 'playlist_uid', flatvalue: true });
  const pl = n?.properties?.playlist_uid;
  if (!pl) return [];
  const base = `${session.path}/playlists/${pl}/clips`;
  const c = await luna.raw.get(base, { levels: 1, properties: false, commands: false }).catch(() => null);
  return (c?.children ?? []).map((k) => `${base}/${k.path}`);
}

/**
 * What the session looks like when a sample row is pressed, to tell LUNA's drop apart later.
 * It is taken before the drag begins and writes nothing: LUNA can be slow to answer while a
 * drag is on, and a snapshot that finished after the drop would hide it (seen 2026-11-26).
 * The undo position is read first; if it moved while the clips were listed, the clip list
 * may already hold something new, so it is marked as not sure.
 */
async function dropSnapshot() {
  const tracks = new Set(session.tracks.items.map((t) => t.id));
  const [entries, uid] = await Promise.all([undoEntries(), undoUid()]);
  const clips = new Map();
  await L.mapLimit(session.tracks.items, 8, async (t) => clips.set(t.id, new Set(await clipPaths(t))));
  const clipsSure = (await undoUid()) === uid;
  const sources = session.sources ?? (await session.loadSources().catch(() => null));
  const lastRow = entries.at(-1)?.rowid ?? -1;
  return { lastRow, undoUid: uid, tracks, clips, clipsSure, sources: sources ? new Set(sources.items.map((x) => x.id)) : null };
}

/**
 * The clip LUNA made from `file` since `snap`: { track, isNew, start, fresh, at } or null.
 * The newest clip named after the file that wasn't there on the press (LUNA names a drop
 * after its file, with "-48k" and the like added when it converts it); when the clip list
 * isn't sure, the newest such clip of all.
 */
async function findDropped(snap, file) {
  const stem = file.name.replace(/\.[^.]+$/, '').toLowerCase();
  const own = new Set(previewer.clipUids);
  let best = null;
  for (const t of session.tracks.items) {
    const before = snap.clipsSure ? (snap.clips.get(t.id) ?? new Set()) : new Set();
    for (const path of await clipPaths(t)) {
      if (before.has(path)) continue;
      const c = (await luna.raw.get(path, { children: false, commands: false, propfilter: ['uid', 'name', 'start', 'source_uid', 'rowid'], flatvalue: true }))?.properties ?? {};
      if (own.has(c.uid) || !String(c.name ?? '').toLowerCase().startsWith(stem)) continue;
      if (!best || (c.rowid ?? 0) > (best.c.rowid ?? 0)) best = { t, c };
    }
  }
  if (!best) return null;
  const { t, c } = best;
  // A file already in the session is reused (no analysis); a fresh import gets LUNA's
  // instrument detection, a second undo entry that is worth waiting for.
  const fresh = snap.sources ? !snap.sources.has(c.source_uid) : c.source_uid !== previewer.sources.get(file.path);
  return { track: t, isNew: !snap.tracks.has(t.id), start: c.start, fresh, at: Date.now() };
}

// Drops are handled one after another. While a drag is on and a drop is being handled, the
// preview adds nothing (previewer.held) and auditions wait: a preview's undo entry landing
// after LUNA's drop would stop the swap.
let dropChain = Promise.resolve();
let dropsPending = 0;
function dropped(file, snapPromise, effect) {
  dropsPending++;
  const run = dropChain.then(() => settleDrop(file, snapPromise, effect)).finally(() => {
    dropsPending--;
    if (!dropsPending && previewer) previewer.held = false;
  });
  dropChain = run.catch(() => undefined);
  return run;
}

/**
 * A sample row was dragged out and let go. Wait for LUNA to place it and go quiet, then swap
 * LUNA's drop for the browser's own placement, which also ends the preview. A cancelled drag
 * leaves the preview playing.
 */
async function settleDrop(file, snapPromise, effect) {
  let swapped = false;
  const auditioned = previewer?.current?.path;
  try {
    const snap = await Promise.race([snapPromise, pause(8000).then(() => null)]).catch(() => null);
    if (!snap || !session || !previewer) return status(`Couldn't follow the drop of ${file.name}: it's left as LUNA made it.`);
    const until = Date.now() + (effect === 'none' ? 3000 : 20000); // LUNA may ask about tempo first
    let last = snap.undoUid, quietSince = Date.now(), found = null, entries = [];
    while (Date.now() < until) {
      await pause(150);
      const u = await undoUid().catch(() => last);
      if (u !== last) {
        last = u;
        quietSince = Date.now();
        entries = (await undoEntries()).filter((x) => x.rowid > snap.lastRow);
      }
      // Once anything has changed, keep looking: LUNA may list the clip a moment after its entry.
      if (!found && last !== snap.undoUid) found = await findDropped(snap, file);
      if (!found) continue;
      const detecting = found.fresh && !entries.some((x) => x.name === L.DETECT_UNDO_NAME) && Date.now() - found.at < 4000;
      if (!detecting && Date.now() - quietSince > 700) break;
    }
    if (!found) return status(effect === 'none' ? `Drag cancelled: drop ${file.name} onto LUNA's timeline.` : `Couldn't see where LUNA put ${file.name}.`);
    const n = L.dropUndoCount(entries.map((x) => x.name));
    if (!n || (await undoUid()) !== last) return status(`LUNA placed ${file.name}; other changes came in, so it's left as LUNA made it.`);
    const keep = entries.length > n ? entries[entries.length - n - 1].uid : snap.undoUid;
    await session.undo(n);
    for (let i = 0; i < 20 && (await undoUid()) !== keep; i++) await pause(50);
    if ((await undoUid()) !== keep) return status(`Undoing LUNA's drop of ${file.name} didn't go as expected: check the undo list.`);
    const target = found.isNew || found.track.name.value === L.PREVIEW_TRACK_NAME ? null : found.track;
    const placed = await previewer.placeAt(file, await tempoFor(file), { track: target, startTick: found.start, loopsOnBar: true, stopPreview: true });
    swapped = true;
    const st = stat(file.path);
    st.adds = (st.adds ?? 0) + 1;
    st.kind = placed.plan.kind;
    prefs.save();
    const bar = session.musical.timeline.barBeat(placed.startTick).bar;
    status(`Added ${file.name} to “${placed.track.name.value ?? ''}” at bar ${bar}${placed.plan.kind === 'loop' ? ` · ${placed.plan.bpm.toFixed(1)} BPM` : ' · one-shot'}`);
  } catch (err) {
    status(`Couldn't finish the drop of ${file.name}: ${err.code ?? err.message}`);
  } finally {
    // A drop left as LUNA made it still ends the preview, as Add does (keeping the transport).
    const was = previewer?.current?.path;
    if (!swapped && was && effect !== 'none') await previewer.stop({ stopTransport: false, onlyOwn: true }).catch(() => undefined);
    for (const x of shown) if (x.path === was || x.path === auditioned || x.path === file.path) paintRow(x);
  }
}

function retempo(e, factor) {
  const b = badgeFor(e);
  const cur = previewer?.current?.path === e.path ? previewer.current.plan.bpm : b.bpm;
  if (factor === 0) delete P.overrides[e.path];
  else if (cur > 0) P.overrides[e.path] = cur * factor;
  else return;
  prefs.save();
  paintRow(e);
  if (previewer?.current?.path === e.path) audition(e);
}

async function bindVolume() {
  if (volumeBound || !previewer) return;
  const track = previewer.findTrack();
  if (!track) return;
  try {
    await track.loadStrip();
    keep(Luna.bindRange($('vol'), track.gain));
    volumeBound = true;
  } catch { /* the fader stays in LUNA */ }
}

// ---------- events ----------
function wireUi() {
  $('lo').value = P.lo; $('hi').value = P.hi; $('autoplay').checked = !!P.autoplay; $('ignore').value = P.ignore;
  $('sort').value = P.sort; $('scope').value = P.scope; $('oneshot').value = P.oneshot;
  $('oneshot').onchange = () => { P.oneshot = $('oneshot').value; prefs.save(); if (previewer) previewer.oneShotRepeat = P.oneshot; };
  $('lo').onchange = () => { P.lo = Number($('lo').value) || 75; prefs.save(); draw(); };
  $('hi').onchange = () => { P.hi = Number($('hi').value) || 150; prefs.save(); draw(); };
  $('autoplay').onchange = () => { P.autoplay = $('autoplay').checked; prefs.save(); };
  $('ignore').onchange = () => { P.ignore = $('ignore').value; prefs.save(); refresh(); };
  let searchTimer = null;
  $('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => refresh({ keepSel: shown[sel]?.path }), 200); };
  $('scope').onchange = () => { P.scope = $('scope').value; prefs.save(); renderChooser(); refresh(); };
  $('sort').onchange = () => { P.sort = $('sort').value; prefs.save(); draw(shown[sel]?.path); };
  for (const id of ['kind', 'minStars', 'colour']) $(id).onchange = () => draw(shown[sel]?.path);
  $('addFolder').onclick = addFolder;
  $('folders').onchange = () => { root = $('folders').value; if (root) openFolder(root); };
  $('up').onclick = () => { if (cwd && cwd !== root) openFolder(parent(cwd), { keepSel: cwd }); };
  $('stop').onclick = stopPreview;
  $('add').onclick = () => addSample();
  $('addSel').onclick = () => addSample({ toSelected: true });
  $('help-btn').onclick = () => $('help').classList.toggle('on');
  // LUNA only reloads an Add On page when it restarts: double-click the status line instead.
  $('status').ondblclick = () => location.reload();
  $('help').onclick = () => $('help').classList.remove('on');

  $('list').onclick = (ev) => {
    const row = ev.target.closest('.row');
    if (!row) return;
    const i = Number(row.dataset.i);
    const e = shown[i];
    const star = ev.target.closest('[data-star]');
    if (star && i === sel) { const n = Number(star.dataset.star); return rate(e, (P.stats[e.path]?.stars ?? 0) === n ? 0 : n); }
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'colour') return cycleColour(e);
    if (act) return retempo(e, { half: 0.5, double: 2, reset: 0 }[act]);
    if (e.isDirectory) return openFolder(e.path);
    select(i);
    audition(e);
  };

  document.addEventListener('keydown', (ev) => {
    if (ev.target.matches('input, select')) {
      if (ev.key === 'Escape' || (ev.key === 'ArrowDown' && ev.target.id === 'search')) { ev.preventDefault(); ev.target.blur(); $('list').focus(); if (sel < 0) select(0); }
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return; // leave LUNA's own shortcuts alone
    const e = shown[sel];
    const key = ev.key;
    const handled = {
      ArrowDown: () => select(Math.min(sel + 1, Math.min(shown.length, MAX_ROWS) - 1), { play: P.autoplay }),
      ArrowUp: () => select(Math.max(sel - 1, 0), { play: P.autoplay }),
      ArrowRight: () => e?.isDirectory && openFolder(e.path),
      ArrowLeft: () => cwd && cwd !== root && openFolder(parent(cwd), { keepSel: cwd }),
      Enter: () => (e?.isDirectory ? openFolder(e.path) : ev.shiftKey ? addSample({ toSelected: true }) : previewer?.current?.path === e?.path ? addSample() : e && audition(e)),
      Escape: () => ($('help').classList.contains('on') ? $('help').classList.remove('on') : stopPreview()),
      '/': () => $('search').focus(),
      '?': () => $('help').classList.toggle('on'),
      c: () => cycleColour(e),
      C: () => cycleColour(e),
    }[key] ?? (/^[0-5]$/.test(key) ? () => rate(e, Number(key)) : null);
    if (handled) { ev.preventDefault(); handled(); }
  });

  // Drag a sample out onto LUNA's timeline. LUNA places the clip itself (SDK fact 241): on a
  // track's lane at the drop point, elsewhere on a new track.
  // The drag picture is a small label with its left edge at the pointer: WebKit's own picture
  // of the whole row sits left of the pointer by wherever you grabbed the row. It is made on
  // pointer down, so it has loaded by the time the drag starts. The session snapshot that
  // tells LUNA's drop apart is taken on pointer down too, before any drag (see dropSnapshot).
  let dragging = null, picture = null, snapshot = Promise.resolve(null);
  $('list').addEventListener('pointerdown', (ev) => {
    const row = ev.target.closest?.('.row');
    const e = row && shown[Number(row.dataset.i)];
    const audio = e && !e.isDirectory && ev.button === 0;
    picture = audio ? dragPicture(e.name.replace(/\.[^.]+$/, '')) : null;
    snapshot = audio && session && previewer ? dropSnapshot() : Promise.resolve(null);
    snapshot.catch(() => undefined); // most presses are clicks: nobody waits on it
  });
  $('list').addEventListener('dragstart', (ev) => {
    const row = ev.target.closest?.('.row');
    const e = row && shown[Number(row.dataset.i)];
    if (!e || e.isDirectory) return ev.preventDefault();
    try { Luna.startSourceDrag(ev, { path: e.path }); dragging = e; } catch { return ev.preventDefault(); }
    if (picture?.complete && picture.naturalWidth) ev.dataTransfer.setDragImage(picture, 0, DRAG_PICTURE_H / 2);
    // Nothing is written while the drag is on: the preview keeps playing but adds nothing.
    if (previewer) previewer.held = true;
  });
  $('list').addEventListener('dragend', (ev) => {
    const e = dragging;
    dragging = null;
    if (e) dropped(e, snapshot, ev.dataTransfer?.dropEffect ?? 'unknown');
    else if (previewer && !dropsPending) previewer.held = false;
  });

  // Drop a folder (or a sample) from Finder onto the panel.
  if (Luna.canDropPaths()) {
    Luna.onPathDrop({
      dragOver: () => $('list').classList.add('drop'),
      dragLeave: () => $('list').classList.remove('drop'),
      drop: async ({ paths }) => {
        $('list').classList.remove('drop');
        const p = paths[0];
        if (!p) return;
        if (L.isAudio(p)) return audition({ path: p, name: base(p), isDirectory: false });
        await adoptFolder(p);
      },
    });
  }
  window.addEventListener('pagehide', () => { previewer?.stop(); });
}

// ---------- session ----------
async function bindSession() {
  const next = luna.sessions.current();
  if (next && next === session && previewer) return; // same session: nothing to rebind
  release();
  volumeBound = false;
  // Tidy up the old session's preview, but never wait on it: it may have closed, and a request
  // to a session that's gone can go unanswered. Leftovers are cleared on the next audition.
  if (previewer && session && next !== session) previewer.stop({ stopTransport: false }).catch(() => undefined);
  session = next;
  previewer = null;
  if (!session) return status('Open a session in LUNA to audition.');
  await session.ready();
  previewer = new L.Previewer(luna, session);
  previewer.oneShotRepeat = P.oneshot;
  const t = session.transport;
  // You stopped LUNA: clear the preview clips, leave the transport alone.
  keep(t.playing.onChange(() => {
    if (t.playing.value === false && previewer?.current) {
      const was = previewer.current.path;
      previewer.stop({ stopTransport: false }).then(() => { for (const x of shown) if (x.path === was) paintRow(x); });
      status('Stopped');
    }
  }));
  // Keep a loop going as the playhead moves on.
  keep(t.location.onChange(() => previewer?.extend()));
  bindVolume();
  status(`${session.name.value ?? 'Session'} · ${t.tempo.value ?? '--'} BPM`);
}

async function connect() {
  wireUi();
  for (;;) {
    try { luna = await Luna.connect(); break; } catch (e) {
      status(e instanceof Luna.NotRunning ? 'Waiting for LUNA…' : e.message);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  Luna.bindShortcuts(luna);
  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  luna.status.onChange(() => { if (luna.status.value === 'disconnected') status('Reconnecting to LUNA…'); });
  await bindSession();
  if (await luna.gui.available()) {
    await luna.gui.watchBlessedFolders();
    luna.gui.blessedFolders.onChange(() => { renderFolders(); renderChooser(); deepCache.clear(); });
    renderFolders();
    renderChooser();
    if (root) await openFolder(P.cwd && P.cwd.startsWith(root) ? P.cwd : root);
  } else {
    status('Open the Sample Browser from LUNA (Add Ons > Browsers) to browse folders.');
  }
  renderList();
}

connect();
