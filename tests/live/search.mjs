// Read-only: list a big blessed folder past LUNA's 10,000-entry limit and search it.
//   node tests/live/search.mjs <folder you added in the browser> [word]
import { Luna } from '@uaudio/luna-builder-sdk';
globalThis.Luna = Luna;
await import('../../logic.js');
const L = globalThis.AddOnLogic;
const folder = process.argv[2];
if (!folder) { console.log('usage: node tests/live/search.mjs <folder> [word]'); process.exit(1); }
const q = L.parseQuery(process.argv[3] ?? 'oliver');
const luna = await Luna.connect();
let t = Date.now();
const one = await luna.gui.listAllFiles(folder);
console.log(`listAllFiles alone: ${one.files.length} entries, truncated ${one.truncated}, ${Date.now() - t} ms`);
let calls = 0;
t = Date.now();
const r = await L.listTree(folder, { listAll: (p) => { calls++; return luna.gui.listAllFiles(p); }, listDir: (p) => luna.gui.listFiles(p) });
const base = folder.split('/').pop();
const hits = r.files.filter((f) => !f.isDirectory && L.isAudio(f.name) && L.matches(`${base}/${f.relativePath}`, q));
console.log(`listTree: ${r.files.length} entries, truncated ${r.truncated}, ${calls} listAllFiles calls, ${Date.now() - t} ms; ${hits.length} audio files match; first: ${hits[0]?.relativePath}`);
console.log('duplicates:', r.files.length - new Set(r.files.map((f) => f.path)).size);
process.exit(0);
