// Sample Browser: DOM wiring. Browse LUNA's blessed folders, audition through the Previewer
// (logic.js), and keep the per-viewer conveniences (last folder, tempo range, tempo fixes) in
// localStorage.

const $ = (id) => document.getElementById(id);
const L = AddOnLogic;
const STORE_KEY = 'com.ranrun.sample_browser';

// ---------- per-viewer settings ----------
const prefs = (() => {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { data = {}; }
  data.lo ??= 75; data.hi ??= 150; data.autoplay ??= true;
  data.detected ??= {}; data.overrides ??= {};
  return {
    data,
    save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* private mode: fine */ } },
  };
})();
const P = prefs.data;

// ---------- state ----------
let luna, session, previewer;
let releases = [];
const keep = (u) => u && releases.push(u);
const release = () => { for (const u of releases) { try { typeof u === 'function' ? u() : (u.dispose ?? u.release ?? u.unbind)?.call(u); } catch { /* gone */ } } releases = []; };
let root = null, cwd = null, entries = [], shown = [], sel = -1;
let volumeBound = false;
let detectRun = 0;

const status = (text) => { $('status').textContent = text; };
const base = (p) => p.replace(/\/+$/, '').split('/').pop();
const parent = (p) => p.replace(/\/+$/, '').replace(/\/[^/]+$/, '') || '/';

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

function badgeHtml(entry) {
  if (entry.isDirectory) return '';
  const b = badgeFor(entry);
  if (b.src === 'pending') return '<span title="Asking LUNA for the tempo">…</span>';
  if (b.src === 'none') return '<span title="No tempo found: plays as a one-shot unless it is long enough to guess from its length">—</span>';
  return `<b>${b.bpm.toFixed(b.bpm % 1 ? 1 : 0)}</b> ${L.sourceLabel(b.src)}`;
}

/** Ask LUNA for the tempo of every file in view that has no BPM in its name, one at a time. */
async function detectInBackground() {
  const run = ++detectRun;
  for (const e of shown) {
    if (run !== detectRun) return;
    if (e.isDirectory || L.nameBpm(e.name) || P.detected[e.path] !== undefined) continue;
    P.detected[e.path] = await L.detectTempo(luna, e.path);
    prefs.save();
    paintRow(e);
  }
}

// ---------- folders ----------
function renderFolders() {
  const folders = luna?.gui.blessedFolders.value ?? [];
  const sel = $('folders');
  sel.innerHTML = '';
  if (!folders.length) {
    sel.innerHTML = '<option value="">No sample folders yet — click + Folder</option>';
    return;
  }
  for (const f of folders) {
    const o = document.createElement('option');
    o.value = f; o.textContent = base(f); o.title = f;
    sel.appendChild(o);
  }
  if (!root || !folders.includes(root)) root = folders.includes(P.root) ? P.root : folders.at(-1);
  sel.value = root;
}

async function openFolder(path, { keepSel = null } = {}) {
  try {
    const list = await luna.gui.listFiles(path);
    cwd = path;
    P.cwd = cwd; P.root = root; prefs.save();
    entries = [
      ...list.filter((e) => e.isDirectory),
      ...list.filter((e) => !e.isDirectory && L.isAudio(e.name)),
    ];
    applyFilter(keepSel);
    $('crumbs').textContent = cwd === root ? base(root) : `${base(root)} / ${cwd.slice(root.length + 1).split('/').join(' / ')}`;
    $('crumbs').title = cwd;
    $('up').disabled = cwd === root;
    detectInBackground();
  } catch (e) {
    status(e.code === 'uasrv.not_permitted' ? `LUNA won't let Add Ons read ${base(path)}. Add it with + Folder.` : `Can't open ${base(path)}: ${e.code ?? e.message}`);
  }
}

function applyFilter(keepPath = null) {
  const q = $('filter').value.trim().toLowerCase();
  shown = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
  sel = keepPath ? shown.findIndex((e) => e.path === keepPath) : -1;
  renderList();
}

async function addFolder() {
  if (!(await luna.gui.available())) return status('Open the Sample Browser inside LUNA to add folders.');
  try {
    const [folder] = await luna.gui.chooseFolders({ title: 'Choose a sample folder' });
    if (!folder) return;
    await adoptFolder(folder);
  } catch (e) {
    status(`Couldn't open LUNA's folder dialog (${e.code ?? e.message}). Add folders in Settings > Add Ons > FOLDERS, or drop one here.`);
  }
}

/** Make `folder` the root, asking LUNA to allow it if needed. */
async function adoptFolder(folder) {
  const allowed = () => (luna.gui.blessedFolders.value ?? []).some((f) => folder === f || folder.startsWith(f + '/'));
  if (!allowed()) {
    status(`Allow ${base(folder)} in LUNA's prompt…`);
    try { await luna.gui.addBlessedFolder(folder); } catch (e) { return status(`LUNA refused ${base(folder)} (${e.code ?? e.message}). Pick a folder inside it, not a whole drive or your home folder.`); }
    for (let i = 0; i < 600 && !allowed(); i++) await new Promise((r) => setTimeout(r, 100));
    if (!allowed()) return status(`${base(folder)} wasn't allowed.`);
  }
  const blessedRoot = (luna.gui.blessedFolders.value ?? []).find((f) => folder === f || folder.startsWith(f + '/'));
  root = blessedRoot;
  renderFolders();
  await openFolder(folder);
  status(`Browsing ${base(folder)}`);
}

// ---------- list ----------
function rowHtml(e, i) {
  const playing = previewer?.current?.path === e.path;
  const tools = e.isDirectory ? '' : `<span class="tools"><button data-act="half" title="Half the tempo">½×</button><button data-act="double" title="Double the tempo">2×</button>${P.overrides[e.path] ? '<button data-act="reset" title="Go back to the detected tempo">reset</button>' : ''}</span>`;
  return `<div class="row${i === sel ? ' sel' : ''}${playing ? ' playing' : ''}" data-i="${i}"><span class="icon">${e.isDirectory ? '▸' : '♪'}</span><span class="name"></span>${tools}<span class="bpm">${badgeHtml(e)}</span></div>`;
}

function renderList() {
  const list = $('list');
  if (!shown.length) {
    list.innerHTML = `<div class="empty">${cwd ? 'No audio files or folders here.' : 'Add a sample folder with <b>+ Folder</b>, or drop one onto this panel.<br>LUNA asks you to allow it the first time.'}</div>`;
    return;
  }
  list.innerHTML = shown.map(rowHtml).join('');
  list.querySelectorAll('.row').forEach((row) => { row.querySelector('.name').textContent = shown[Number(row.dataset.i)].name; });
}

function paintRow(e) {
  const i = shown.indexOf(e);
  const row = $('list').querySelector(`.row[data-i="${i}"]`);
  if (!row) return;
  row.outerHTML = rowHtml(e, i);
  $('list').querySelector(`.row[data-i="${i}"] .name`).textContent = e.name;
}

function select(i, { play = false } = {}) {
  if (i < 0 || i >= shown.length) return;
  const old = sel;
  sel = i;
  if (shown[old]) paintRow(shown[old]);
  paintRow(shown[i]);
  $('list').querySelector(`.row[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  if (play && !shown[i].isDirectory) audition(shown[i]);
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

async function addToSession() {
  if (!previewer?.current) {
    const e = shown[sel];
    if (e && !e.isDirectory) { await audition(e); } else return status('Pick a sample first.');
  }
  const name = previewer.current?.name;
  try {
    const added = await previewer.addToSession();
    if (added) status(`Added ${name} to “${added.track.name.value ?? name}”${added.filledLoop ? ` — filled the loop range (${added.clips} clip${added.clips > 1 ? 's' : ''})` : ''}`);
  } catch (err) { status(`Couldn't add ${name}: ${err.code ?? err.message}`); }
}

function retempo(e, factor) {
  const b = badgeFor(e);
  const cur = previewer?.current?.path === e.path ? previewer.current.plan.bpm : b.bpm;
  if (!(cur > 0)) return;
  P.overrides[e.path] = factor === 0 ? undefined : cur * factor;
  if (factor === 0) delete P.overrides[e.path];
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
  $('lo').value = P.lo; $('hi').value = P.hi; $('autoplay').checked = !!P.autoplay;
  $('lo').onchange = () => { P.lo = Number($('lo').value) || 75; prefs.save(); renderList(); };
  $('hi').onchange = () => { P.hi = Number($('hi').value) || 150; prefs.save(); renderList(); };
  $('autoplay').onchange = () => { P.autoplay = $('autoplay').checked; prefs.save(); };
  $('filter').oninput = () => applyFilter(shown[sel]?.path);
  $('addFolder').onclick = addFolder;
  $('folders').onchange = () => { root = $('folders').value; if (root) openFolder(root); };
  $('up').onclick = () => { if (cwd && cwd !== root) openFolder(parent(cwd), { keepSel: cwd }); };
  $('stop').onclick = stopPreview;
  $('add').onclick = addToSession;

  $('list').onclick = (ev) => {
    const row = ev.target.closest('.row');
    if (!row) return;
    const e = shown[Number(row.dataset.i)];
    const act = ev.target.closest('button')?.dataset.act;
    if (act) { ev.stopPropagation(); return retempo(e, { half: 0.5, double: 2, reset: 0 }[act]); }
    if (e.isDirectory) return openFolder(e.path);
    select(Number(row.dataset.i));
    audition(e);
  };

  document.addEventListener('keydown', (ev) => {
    if (ev.target.matches('input, select')) return;
    const e = shown[sel];
    const handled = {
      ArrowDown: () => select(Math.min(sel + 1, shown.length - 1), { play: P.autoplay }),
      ArrowUp: () => select(Math.max(sel - 1, 0), { play: P.autoplay }),
      ArrowRight: () => e?.isDirectory && openFolder(e.path),
      ArrowLeft: () => cwd && cwd !== root && openFolder(parent(cwd), { keepSel: cwd }),
      Enter: () => (e?.isDirectory ? openFolder(e.path) : previewer?.current?.path === e?.path ? addToSession() : e && audition(e)),
      Escape: () => stopPreview(),
    }[ev.key];
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
  if (previewer && session && next !== session) await previewer.stop().catch(() => undefined);
  session = next;
  previewer = null;
  if (!session) return status('Open a session in LUNA to audition.');
  await session.ready();
  previewer = new L.Previewer(luna, session);
  const t = session.transport;
  // You stopped LUNA: clear the preview clips, leave the transport alone.
  keep(t.playing.onChange(() => { if (t.playing.value === false && previewer?.current) { const was = previewer.current.path; previewer.stop({ stopTransport: false }).then(() => { for (const x of shown) if (x.path === was) paintRow(x); }); status('Stopped'); } }));
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
    luna.gui.blessedFolders.onChange(renderFolders);
    renderFolders();
    if (root) await openFolder(P.cwd && P.cwd.startsWith(root) ? P.cwd : root);
  } else {
    status('Open the Sample Browser from LUNA (Add Ons > Browsers) to browse folders.');
  }
  renderList();
}

connect();
