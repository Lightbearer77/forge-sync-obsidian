'use strict';
// Zero-dependency tests. Run: node test/run-tests.js
const assert = require('assert');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'obsidian') {
    class Plugin {}
    class PluginSettingTab {}
    class Modal {}
    class Setting {}
    class Notice {}
    return { Plugin, PluginSettingTab, Setting, Notice, Modal, requestUrl() {} };
  }
  return origLoad.call(this, req, ...rest);
};

const P = require('../main.js');
const { rewriteLine, splitName, formatTaskLine, formatMilestoneLine, greekMonthOf, greekMonthTagOf, isoWeekTagOf, TASK_LINE } = P._internals;

let passed = 0;
const t = (name, fn) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL:', name, '\n', e.message); process.exitCode = 1; }
};
const same = (a, b, msg) => { assert.strictEqual(a, b, msg); };

const task = (o) => ({ name: 'X', dueDate: '', month: '', week: '', priority: 'Mid', goal: 'G1', status: 'todo', flagDate: '', ...o });
const ms = (o) => ({ name: 'M', dueDate: '', msTag: '', msWeek: '', goal: 'G1', ...o });

/* ── task lines ── */
t('retag due/month/week', () => {
  const line = '- [ ] Review protective order — send to friend [due:: 2026-08-08] #Q3 #M08 #W32 #High #G2 🆔 c01';
  const r = rewriteLine(line, task({ name: 'Review protective order — send to friend', dueDate: '2026-11-20', month: 'M12', week: 'W47', priority: 'High', goal: 'G2' }), 'task');
  same(r.after, '- [ ] Review protective order — send to friend [due:: 2026-11-20] #Q4 #M12 #W47 #High #G2 🆔 c01');
  assert.ok(r.changes.length === 1);
});

t('idempotent', () => {
  const rec = task({ name: 'A', dueDate: '2026-11-20', month: 'M12', week: 'W47', priority: 'High', goal: 'G2' });
  const a = rewriteLine('- [ ] A [due:: 2026-01-01] #Q1 #M01 #W01 #Low #G1 🆔 x', rec, 'task').after;
  const b = rewriteLine(a, rec, 'task');
  same(b.after, a); same(b.changes.length, 0);
});

t('name containing #3 survives', () => {
  const line = '- [ ] Body composition scan #3 (pre-gate) [due:: 2026-11-25] #Q4 #M12 #W48 #High #G3 🆔 f26_082';
  const r = rewriteLine(line, task({ name: 'Body composition scan #3 (pre-gate)', dueDate: '2026-11-25', month: 'M12', week: 'W48', priority: 'High', goal: 'G3' }), 'task');
  same(r.after, line);
});

t('name sync on/off', () => {
  const line = '- [ ] Old name [due:: 2026-11-25] #Q4 #M12 #W48 #High #G3 🆔 a';
  const rec = task({ name: 'New name', dueDate: '2026-11-25', month: 'M12', week: 'W48', priority: 'High', goal: 'G3' });
  same(rewriteLine(line, rec, 'task').after, '- [ ] New name [due:: 2026-11-25] #Q4 #M12 #W48 #High #G3 🆔 a');
  same(rewriteLine(line, rec, 'task', { syncNames: false }).after, line);
});

t('on hold strips date and month/week, keeps priority+goal', () => {
  const line = '- [ ] War council [due:: 2026-11-04] #Q4 #M11 #W45 #High #G2 🆔 f26_079';
  const r = rewriteLine(line, task({ name: 'War council', priority: 'High', goal: 'G2', status: 'backlog' }), 'task');
  same(r.after, '- [ ] War council #High #G2 🆔 f26_079');
});

t('undated line gains tags when Forge gives a date', () => {
  const r = rewriteLine('- [ ] Thing #Low #G3 🆔 z', task({ name: 'Thing', dueDate: '2026-12-02', month: 'M12', week: 'W49', priority: 'Low', goal: 'G3' }), 'task');
  same(r.after, '- [ ] Thing [due:: 2026-12-02] #Q4 #M12 #W49 #Low #G3 🆔 z');
});

t('line with no managed tokens inserts before 🆔', () => {
  const r = rewriteLine('- [ ] Bare 🆔 q', task({ name: 'Bare', dueDate: '2026-11-06', month: 'M12', week: 'W45', priority: 'Mid', goal: 'G3' }), 'task');
  same(r.after, '- [ ] Bare [due:: 2026-11-06] #Q4 #M12 #W45 #Mid #G3 🆔 q');
});

t('unmanaged tokens and trailing text preserved', () => {
  const line = '- [ ] Task [due:: 2026-01-01] #Q1 #M01 #W01 #Low #G1 #HabitNow 🆔 id9 *(note)*';
  const r = rewriteLine(line, task({ name: 'Task', dueDate: '2026-11-06', month: 'M12', week: 'W45', priority: 'Low', goal: 'G1' }), 'task');
  same(r.after, '- [ ] Task [due:: 2026-11-06] #Q4 #M12 #W45 #Low #G1 #HabitNow 🆔 id9 *(note)*');
});

t('quarter mapping', () => {
  const q = (m) => /#Q(\d)/.exec(rewriteLine('- [ ] A 🆔 i', task({ name: 'A', dueDate: '2026-01-01', month: m, week: 'W01' }), 'task').after)[1];
  same(q('M01'), '1'); same(q('M03'), '1'); same(q('M04'), '2'); same(q('M09'), '3'); same(q('M10'), '4'); same(q('M13'), '4');
});

t('retired → cancelled, then stable, then un-retire reopens', () => {
  const line = '- [ ] Old plan [due:: 2026-11-16] #Q4 #M12 #W47 #High #G4 🆔 f26_075';
  const rec = task({ name: 'Old plan', status: 'retired', flagDate: '2026-11-05', priority: 'High', goal: 'G4', dueDate: '', month: '', week: '' });
  const r = rewriteLine(line, rec, 'task');
  same(r.after, '- [-] Old plan #High #G4 🆔 f26_075 ❌ 2026-11-05');
  same(rewriteLine(r.after, rec, 'task').after, r.after);
  const back = rewriteLine(r.after, task({ name: 'Old plan', dueDate: '2026-11-16', month: 'M12', week: 'W47', priority: 'High', goal: 'G4' }), 'task');
  same(back.after, '- [ ] Old plan [due:: 2026-11-16] #Q4 #M12 #W47 #High #G4 🆔 f26_075');
});

/* ── milestone lines ── */
t('milestone retag keeps #L', () => {
  const line = '- [ ] Protective order reviewed `due:: 2026-06-30` (@2026-06-30) #MS12 #MSW26 #G2 #L2 🆔 ms6_03';
  const r = rewriteLine(line, ms({ name: 'Protective order reviewed', dueDate: '2026-11-20', msTag: 'MS12', msWeek: 'MSW47', goal: 'G2' }), 'milestone');
  same(r.after, '- [ ] Protective order reviewed `due:: 2026-11-20` (@2026-11-20) #MS12 #MSW47 #G2 #L2 🆔 ms6_03');
});

t('milestone parked to #MS2027 drops date and week', () => {
  const line = '- [ ] Body scan `due:: 2026-11-25` (@2026-11-25) #MS12 #G3 #L1 🆔 ms11_02';
  const r = rewriteLine(line, ms({ name: 'Body scan', msTag: 'MS2027', goal: 'G3' }), 'milestone');
  same(r.after, '- [ ] Body scan #MS2027 #G3 #L1 🆔 ms11_02');
  same(rewriteLine(r.after, ms({ name: 'Body scan', msTag: 'MS2027', goal: 'G3' }), 'milestone').after, r.after);
});

t('milestone MSW vs MS regex do not collide', () => {
  const line = '- [ ] T `due:: 2026-12-02` (@2026-12-02) #MS12 #MSW49 #G1 #L4 🆔 m';
  const r = rewriteLine(line, ms({ name: 'T', dueDate: '2026-12-02', msTag: 'MS12', msWeek: 'MSW49', goal: 'G1' }), 'milestone');
  same(r.after, line);
});

/* ── formatting + calendar ── */
t('format lines round-trip as stable', () => {
  const rec = task({ id: 'f26_170', name: 'Habit', dueDate: '2026-11-06', month: 'M12', week: 'W45', priority: 'Mid', goal: 'G3' });
  const l = formatTaskLine(rec);
  same(l, '- [ ] Habit [due:: 2026-11-06] #Q4 #M12 #W45 #Mid #G3 🆔 f26_170');
  same(rewriteLine(l, rec, 'task').after, l);
  const m = ms({ id: 'ms1', name: 'T', dueDate: '2026-12-30', msTag: 'MS13', goal: 'G4' });
  same(formatMilestoneLine(m), '- [ ] T `due:: 2026-12-30` (@2026-12-30) #MS13 #G4 🆔 ms1');
});

t('greek month', () => {
  same(greekMonthOf(new Date(2026, 0, 1)), 1);
  same(greekMonthOf(new Date(2026, 10, 5)), 12);
  same(greekMonthOf(new Date(2026, 11, 2)), 12);
  same(greekMonthOf(new Date(2026, 11, 3)), 13);
  same(greekMonthOf(new Date(2026, 11, 31)), 13);
});

/* ── derivation ── */
t('derive month/week from due date when Forge fields are blank', () => {
  same(greekMonthTagOf('2026-05-28'), 'M06'); same(greekMonthTagOf('2026-11-05'), 'M12'); same(greekMonthTagOf('2026-12-31'), 'M13');
  same(isoWeekTagOf('2026-11-02'), 'W45'); same(isoWeekTagOf('2026-11-08'), 'W45'); same(isoWeekTagOf('2026-11-09'), 'W46');
  same(isoWeekTagOf('2026-12-30'), 'W53'); same(isoWeekTagOf('2026-01-01'), 'W01');
  const r = rewriteLine('- [ ] A [due:: 2026-05-28] #Q2 #M06 #W22 #High #G1 🆔 v10', task({ name: 'A', dueDate: '2026-05-28', month: '', week: '', priority: 'High', goal: 'G1' }), 'task');
  same(r.after, '- [ ] A [due:: 2026-05-28] #Q2 #M06 #W22 #High #G1 🆔 v10');
  // Forge month wins over derivation when set
  const m = rewriteLine('- [ ] A 🆔 v', task({ name: 'A', dueDate: '2026-06-30', month: 'M06', week: 'W26' }), 'task');
  assert.ok(m.after.includes('#M06') && m.after.includes('#Q2'));
});
t('no due date → no month/week tags even if Forge month is stale', () => {
  const r = rewriteLine('- [ ] Held #Q3 #M08 #W32 #Mid #G3 🆔 f26_008', task({ name: 'Held', dueDate: '', month: 'M08', week: 'W32', priority: 'Mid', goal: 'G3', status: 'backlog' }), 'task');
  same(r.after, '- [ ] Held #Mid #G3 🆔 f26_008');
});
t('vault *(annotation)* kept when the name itself is unchanged; rename replaces', () => {
  const line = '- [ ] Offsite backup *(the reason this exists)* [due:: 2026-08-03] #Q3 #M08 #W32 #High #G1 🆔 f26_021';
  const rec = task({ name: 'Offsite backup', dueDate: '2026-08-03', month: 'M08', week: 'W32', priority: 'High', goal: 'G1' });
  same(rewriteLine(line, rec, 'task').after, line);
  const r = rewriteLine(line, { ...rec, name: 'Offsite backup v2' }, 'task');
  same(r.after, '- [ ] Offsite backup v2 [due:: 2026-08-03] #Q3 #M08 #W32 #High #G1 🆔 f26_021');
});

/* ── plan ── */
const mkPlugin = (over = {}) => {
  const p = new P();
  p.settings = Object.assign({}, P._internals.DEFAULT_SETTINGS, { dryRun: false }, over);
  return p;
};
const hit = (path, lineNo, line) => {
  const m = TASK_LINE.exec(line);
  const idm = /🆔\s*([A-Za-z0-9_\-]+)/.exec(m[4]);
  return { file: { path, basename: path.split('/').pop() }, lineNo, id: idm[1], marker: m[2], state: m[2] === '-' ? 'cancelled' : m[2] === ' ' ? 'open' : 'done', idCount: (m[4].match(/🆔/g) || []).length, line, text: m[4] };
};
const idx = (tasks, milestones = [], deleted = []) => {
  const byId = new Map(), kindById = new Map(), tombstones = new Set(deleted);
  tasks.forEach((r) => { byId.set(r.id, r); kindById.set(r.id, 'task'); });
  milestones.forEach((r) => { byId.set(r.id, r); kindById.set(r.id, 'milestone'); });
  return { byId, kindById, tombstones };
};
const MPL = 'Tasks/Master Priority List.md';

t('plan: metadata only in metadata files; completions everywhere', () => {
  const p = mkPlugin();
  const rec = task({ id: 'a', name: 'A', dueDate: '2026-11-06', month: 'M12', week: 'W45', priority: 'Mid', goal: 'G1' });
  const hits = [
    hit(MPL, 3, '- [ ] A [due:: 2026-01-01] #Q1 #M01 #W01 #Mid #G1 🆔 a'),
    hit('2026/note.md', 2, '- [ ] A [due:: 2026-01-01] #Q1 #M01 #W01 #Mid #G1 🆔 a'),
  ];
  // a mention in another note does not block the metadata line; only the MPL line is rewritten
  const plan = p.buildPlan(hits, idx([rec]), new Date(2026, 10, 5));
  same(plan.duplicates.length, 0); same(plan.toUpdate.length, 1); same(plan.toUpdate[0].file.path, MPL);
  // same id twice inside the metadata files → both skipped as duplicates
  const dup = p.buildPlan([hits[0], hit(MPL, 9, '- [ ] A [due:: 2026-02-02] #Q1 #M02 #W06 #Mid #G1 🆔 a')], idx([rec]), new Date(2026, 10, 5));
  same(dup.duplicates.length, 2); same(dup.toUpdate.length, 0);
  // single occurrence in a non-metadata file → untouched
  const plan2 = p.buildPlan([hits[1]], idx([rec]), new Date(2026, 10, 5));
  same(plan2.toUpdate.length, 0); same(plan2.alreadyInSync, 1);
  // completion applies anywhere
  const done = { ...rec, completed: true, completedAt: '2026-11-05' };
  const plan3 = p.buildPlan([hits[1]], idx([done]), new Date(2026, 10, 5));
  same(plan3.toApply.length, 1);
  same(plan3.toApply[0].after, '- [x] A [due:: 2026-01-01] #Q1 #M01 #W01 #Mid #G1 🆔 a ✅ 2026-11-05');
});

t('plan: done lines never rewritten; vault-ahead reported', () => {
  const p = mkPlugin();
  const rec = task({ id: 'r', name: 'R', dueDate: '2026-11-06', month: 'M12', week: 'W45' });
  const plan = p.buildPlan([hit(MPL, 1, '- [x] R [due:: 2026-08-09] #Q3 #M08 #W32 #Mid #G1 🆔 r ✅ 2026-08-09')], idx([rec]), new Date(2026, 10, 5));
  same(plan.toUpdate.length, 0); same(plan.vaultAhead.length, 1);
});

t('plan: line with two 🆔 is ambiguous', () => {
  const p = mkPlugin();
  const rec = task({ id: 'r07', name: 'X', dueDate: '2026-12-02', month: 'M12', week: 'W49' });
  const plan = p.buildPlan([hit(MPL, 1, '- [ ] X *(BLOCKED by 🆔 r07)* [due:: 2026-06-21] #Q2 #M07 #W25 #High #G1 🆔 r07')], idx([rec]), new Date(2026, 10, 5));
  same(plan.ambiguous.length, 1); same(plan.toUpdate.length, 0);
});

t('plan: syncMetadata off → completions only', () => {
  const p = mkPlugin({ syncMetadata: false });
  const rec = task({ id: 'a', name: 'A', dueDate: '2026-11-06', month: 'M12', week: 'W45' });
  const plan = p.buildPlan([hit(MPL, 1, '- [ ] A [due:: 2026-01-01] #Q1 #M01 #W01 #Mid #G1 🆔 a')], idx([rec]), new Date(2026, 10, 5));
  same(plan.toUpdate.length, 0); same(plan.missing.tasks.length, 0);
});

t('plan: missing report — current month onward, open, non-retired only', () => {
  const p = mkPlugin();
  const tasks = [
    task({ id: 'now', name: 'N', dueDate: '2026-11-06', month: 'M12' }),
    task({ id: 'next', name: 'Nx', dueDate: '2026-12-10', month: 'M13' }),
    task({ id: 'past', name: 'P', dueDate: '2026-08-01', month: 'M08' }),
    task({ id: 'undated', name: 'U' }),
    task({ id: 'ret', name: 'R', dueDate: '2026-11-06', month: 'M12', status: 'retired' }),
    task({ id: 'done', name: 'D', dueDate: '2026-11-06', month: 'M12', completed: true }),
    task({ id: 'there', name: 'T', dueDate: '2026-11-06', month: 'M12' }),
  ];
  const plan = p.buildPlan([hit(MPL, 1, '- [ ] T [due:: 2026-11-06] #Q4 #M12 #W45 #Mid #G1 🆔 there')], idx(tasks), new Date(2026, 10, 5));
  assert.deepStrictEqual(plan.missing.tasks.map((r) => r.id), ['now', 'next']);
});

t('plan: missing only counts ids present in metadata files', () => {
  const p = mkPlugin();
  const rec = task({ id: 'a', name: 'A', dueDate: '2026-11-06', month: 'M12', week: 'W45', priority: 'Mid', goal: 'G1' });
  const plan = p.buildPlan([hit('2026/Q4/12. Mu/note.md', 1, '- [ ] A 🆔 a')], idx([rec]), new Date(2026, 10, 5));
  assert.deepStrictEqual(plan.missing.tasks.map((r) => r.id), ['a']);
});

/* ── apply ── */
t('plan: deleted in Forge — cancelled/done lines are in sync, open lines are flagged, true orphans stay unmatched', () => {
  const p = mkPlugin();
  const hits = [
    hit(MPL, 1, '- [-] Gone and cancelled #Low #G3 🆔 d1 ❌ 2026-11-01'),
    hit(MPL, 2, '- [x] Gone and done #Low #G3 🆔 d2 ✅ 2026-08-01'),
    hit(MPL, 3, '- [ ] Gone but still open #Low #G3 🆔 d3'),
    hit(MPL, 4, '- [ ] Never existed in Forge #Low #G3 🆔 zz'),
  ];
  const plan = p.buildPlan(hits, idx([], [], ['d1', 'd2', 'd3']), new Date(2026, 10, 5));
  same(plan.alreadyInSync, 2); same(plan.deletedOpen.length, 1); same(plan.deletedOpen[0].id, 'd3');
  same(plan.unmatched.length, 1); same(plan.unmatched[0].id, 'zz');
});
t('indexForge: tombstones collected; a live record beats a tombstone with the same id', () => {
  const p = mkPlugin();
  const ix = p.indexForge({ tasks: [{ id: 'a', deleted: true }, { id: 'b', name: 'B' }, { id: 'b', deleted: true }], milestones: [{ id: 'm', deleted: true }], runes: [] });
  assert.ok(ix.tombstones.has('a') && ix.tombstones.has('m') && !ix.tombstones.has('b'));
  same(ix.byId.size, 1);
});

t('apply: writes planned lines, skips stale ones', async () => {
  const p = mkPlugin();
  const file = { path: MPL, basename: 'Master Priority List.md' };
  let data = ['x', '- [ ] A [due:: 2026-01-01] #Q1 #M01 #W01 #Mid #G1 🆔 a', '- [ ] B 🆔 b'].join('\n');
  p.app = { vault: { process: async (_f, fn) => { data = fn(data); } } };
  const plan = {
    toApply: [],
    toUpdate: [
      { file, lineNo: 1, before: '- [ ] A [due:: 2026-01-01] #Q1 #M01 #W01 #Mid #G1 🆔 a', after: '- [ ] A NEW 🆔 a' },
      { file, lineNo: 2, before: '- [ ] B CHANGED-SINCE-SCAN 🆔 b', after: '- [ ] B NEW 🆔 b' },
    ],
  };
  const res = await p.applyPlan(plan);
  same(res.updated, 1); same(res.stale, 1);
  same(data.split('\n')[1], '- [ ] A NEW 🆔 a'); same(data.split('\n')[2], '- [ ] B 🆔 b');
});

t('upgrade from an older saved config forces Preview back on, once', async () => {
  const saves = [];
  const mk = (saved) => { const p = new P(); p.loadData = async () => saved; p.saveData = async (d) => saves.push(d); p.addRibbonIcon = () => {}; p.addCommand = () => {}; p.addSettingTab = () => {}; p.app = {}; return p; };
  const old = mk({ dryRun: false, syncUrl: 'u' }); await old.onload();
  same(old.settings.dryRun, true); same(old.settings.syncUrl, 'u'); same(old.settings.settingsVersion, 2); same(saves.length, 1);
  const cur = mk({ dryRun: false, settingsVersion: 2 }); await cur.onload();
  same(cur.settings.dryRun, false); same(saves.length, 1);
});

setImmediate(() => console.log(`${passed} passed${process.exitCode ? ', FAILURES above' : ', 0 failed'}`));
