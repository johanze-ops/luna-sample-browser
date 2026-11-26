// Read-only: the newest undo entries, marking where LUNA's undo position (undo_uid) is.
import { Luna } from '@uaudio/luna-builder-sdk';
const luna = await Luna.connect(); const s = await luna.session();
const n = await luna.raw.get(`${s.path}/undo_queues`, { levels: 2, properties: true, commands: false, propfilter: ['rowid', 'uid', 'name'], flatvalue: true });
const u = (await luna.raw.get(s.path, { children: false, commands: false, propfilter: ['undo_uid', 'can_redo'], flatvalue: true })).properties;
const list = (n.children ?? []).map((c) => c.properties).sort((a, b) => a.rowid - b.rowid);
for (const e of list.slice(-22)) console.log(e.rowid, e.name, e.uid === u.undo_uid ? '  <== undo_uid' : '');
console.log('can_redo', u.can_redo, 'entries', list.length);
process.exit(0);
