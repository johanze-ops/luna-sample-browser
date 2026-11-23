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
  const { files, truncated } = await luna.gui.listAllFiles(folder);
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
      if (truncated) note = ' (LUNA stopped listing at 10,000 files: search a folder further down for the rest)';
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
  return `<div class="row${i === sel ? ' sel' : ''}${playing ? ' playing' : ''}" data-i="${i}"><span class="icon">${e.isDirectory ? '▸' : '♪'}</span><span class="text"><div class="name"></div>${e.sub ? '<div class="sub"></div>' : ''}</span>${dot}${stars}${tools}<span class="bpm">${badgeHtml(e)}</span></div>`;
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
async function audition(e) {
  if (!session || !previewer) return status('Open a session in LUNA first.');
  const [lo, hi] = rangeOf();
  if (!P.overrides[e.path] && !L.nameBpm(e.name) && P.detected[e.path] === undefined) {
    P.detected[e.path] = await L.detectTempo(luna, e.path);
    prefs.save();
  }
  const was = previewer.current?.path;
  status(`Loading ${e.name}…`);
  try {
    const cur = await previewer.audition(e, (seconds) => L.resolveTempo({
      name: e.name, seconds, detected: P.detected[e.path], override: P.overrides[e.path], range: [lo, hi],
    }));
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
    const s = stat(cur.path);
    s.adds = (s.adds ?? 0) + 1;
    prefs.save();
    status(`Added ${cur.name} to “${added.track.name.value ?? ''}”${added.filledLoop ? ` — filled the loop range (${added.clips} clip${added.clips > 1 ? 's' : ''})` : ''}`);
  } catch (err) { status(`Couldn't add ${cur.name}: ${err.code ?? err.message}`); }
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
