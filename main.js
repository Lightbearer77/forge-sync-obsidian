'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, Modal, requestUrl } = require('obsidian');

/* ─────────────────────────────────────────────────────────────
   Forge Sync — one-way pull: forge-sync.json → vault task lines.

   Contract:
     · Forge is the write surface. This plugin never sends anything
       back; it only applies Forge's state to the vault.
     · Lines are matched by the Tasks plugin's native ID field
       (🆔 <id>) against task/milestone ids in forge-sync.json.
       No second ID system.
     · COMPLETION. Open here + done in Forge → checked off with the
       Tasks marker (✅ YYYY-MM-DD). An inline [completion:: …] field
       on the same line would override that date in Dataview, so such
       lines are skipped and reported rather than silently written to.
     · METADATA (v0.2). On OPEN lines in the metadata files only
       (default: Master Priority List + Master Milestones), the
       managed tokens are rewritten in place from Forge:
         tasks       name · [due:: D] · #Qn #Mnn #Wnn · #High/#Mid/#Low · #Gn
         milestones  name · `due:: D` (@D) · #MSnn #MSWnn · #Gn
       Everything else on the line (🆔, #L, notes, other tags) is left
       exactly as it was. A task with no due date loses its date and
       month/week tags (on hold / backlog). A RETIRED task becomes a
       cancelled line `[-] … ❌ date` with its date and month/week
       tags removed; if Forge un-retires it, the line reopens.
       Checked (done) lines are history and are never rewritten.
     · Lines are never moved, deleted or inserted. Forge tasks that
       have no line in the metadata files are listed in the report
       with paste-ready lines instead.
     · A vault id appearing on more than one line, or a line with
       more than one 🆔, is ambiguous. Those lines are skipped and
       reported — never guessed at.
     · Vault-ahead-of-Forge lines (done here, open there) are
       reported read-only. Fix those in Forge; this plugin will
       not un-check anything.
   ───────────────────────────────────────────────────────────── */

const SETTINGS_VERSION = 2;

const DEFAULT_SETTINGS = {
  syncUrl: 'https://raw.githubusercontent.com/Lightbearer77/Forge/main/forge-sync.json',
  excludeFolders: 'Archive, Templates, .trash',
  dryRun: true,
  syncMetadata: true,
  syncNames: true,
  metadataFiles: 'Tasks/Master Priority List, Tasks/Master Milestones',
  settingsVersion: SETTINGS_VERSION,
};

const TASK_LINE = /^(\s*(?:[-*+])\s+\[)([ xX\-])(\]\s*)(.*)$/;
const ID_TAG = /🆔\s*([A-Za-z0-9_\-]+)/;
const ID_TAG_ALL = /🆔/g;
const DONE_MARKER = /✅\s*\d{4}-\d{2}-\d{2}/;
const CANCEL_DATE = /\s*❌\s*\d{4}-\d{2}-\d{2}/;
const INLINE_COMPLETION = /\[completion::\s*[^\]]*\]/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// First whitespace before any managed/structural token = end of the task name.
// (A bare "#3" inside a name is not a token, so names like "scan #3" survive.)
const NAME_END =
  /\s(?=\[due::|`due::|#(?:Q[1-4]|M\d{2}|W\d{2}|MSW?\d+|High|Mid|Low|G[1-4]|L[1-6])\b|🆔|✅|❌)/;

const TASK_MANAGED = /\s*(?:\[due::[^\]]*\]|#Q[1-4]\b|#M\d{2}\b|#W\d{2}\b|#(?:High|Mid|Low)\b|#G[1-4]\b)/g;
const MS_MANAGED = /\s*(?:`due::[^`]*`|\(@\d{4}-\d{2}-\d{2}\)|#MS\d+\b|#MSW\d+\b|#G[1-4]\b)/g;

const PLACEHOLDER = '\u0001';

const todayISO = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* ── Greek calendar: thirteen 28-day months, Planning Day (Dec 31) = Nu ── */

const greekMonthOf = (d = new Date()) => {
  const start = new Date(d.getFullYear(), 0, 1);
  const doy = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - start) / 86400000) + 1;
  return Math.min(13, Math.floor((doy - 1) / 28) + 1);
};

// Derive Greek month / ISO week tags from a YYYY-MM-DD date (UTC math, no timezone drift).
const parseISO = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const greekMonthTagOf = (iso) => {
  const dt = parseISO(iso);
  const doy = Math.floor((dt - Date.UTC(dt.getUTCFullYear(), 0, 1)) / 86400000) + 1;
  return `M${String(Math.min(13, Math.floor((doy - 1) / 28) + 1)).padStart(2, '0')}`;
};
const isoWeekTagOf = (iso) => {
  const dt = parseISO(iso);
  const day = dt.getUTCDay() || 7; // Mon=1..Sun=7
  dt.setUTCDate(dt.getUTCDate() + 4 - day); // Thursday of this ISO week
  const week = Math.ceil(((dt - Date.UTC(dt.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  return `W${String(week).padStart(2, '0')}`;
};

const monthNum = (m) => parseInt(String(m || '').replace(/\D/g, ''), 10) || 0;

/* ── Pure line rewriting (exported for tests) ── */

function splitName(body) {
  const m = NAME_END.exec(body);
  return m ? [body.slice(0, m.index), body.slice(m.index)] : [body, ''];
}

// Replace every managed token in `rest` with one canonical segment, placed where
// the first managed token stood (or just before 🆔 when the line had none).
function applyManaged(rest, managedRe, segment) {
  let seen = false;
  let out = rest.replace(managedRe, () => {
    if (!seen) {
      seen = true;
      return PLACEHOLDER;
    }
    return '';
  });
  if (seen) return out.replace(PLACEHOLDER, segment ? ' ' + segment : '');
  if (!segment) return out;
  if (/🆔/.test(out)) return out.replace(/\s*🆔/, ' ' + segment + ' 🆔');
  return out + ' ' + segment;
}

function taskSegment(rec, retired) {
  const p = [];
  // Month/week tags exist only for dated tasks: a task with no due date is on hold
  // or backlog, and a stale month left on it would count toward that month's stats.
  // Forge fields win when set; blanks are derived from the due date.
  const dated = !retired && !!rec.dueDate;
  if (dated) p.push(`[due:: ${rec.dueDate}]`);
  if (dated) {
    const mn = monthNum(rec.month) || monthNum(greekMonthTagOf(rec.dueDate));
    p.push(`#Q${Math.min(4, Math.ceil(mn / 3))}`);
    p.push(`#M${String(mn).padStart(2, '0')}`);
    const wk = /^W\d{2}$/.test(rec.week || '') ? rec.week : isoWeekTagOf(rec.dueDate);
    p.push(`#${wk}`);
  }
  if (['High', 'Mid', 'Low'].includes(rec.priority)) p.push(`#${rec.priority}`);
  if (/^G[1-4]$/.test(rec.goal || '')) p.push(`#${rec.goal}`);
  return p.join(' ');
}

function msSegment(rec) {
  const p = [];
  if (rec.dueDate) {
    p.push('`due:: ' + rec.dueDate + '`');
    p.push(`(@${rec.dueDate})`);
  }
  if (rec.msTag) p.push('#' + rec.msTag);
  if (rec.msWeek) p.push('#' + rec.msWeek);
  if (/^G[1-4]$/.test(rec.goal || '')) p.push(`#${rec.goal}`);
  return p.join(' ');
}

const managedOf = (rest, re) => (rest.match(re) || []).map((s) => s.trim()).join(' ');

/**
 * Compute the desired state of one open/cancelled line.
 * Returns { after, changes[] } — `after` equals the input line when nothing differs.
 */
function rewriteLine(line, rec, kind, opts = {}) {
  const m = TASK_LINE.exec(line);
  if (!m) return { after: line, changes: [] };
  const [, prefix, marker, close, body] = m;

  const retired = kind === 'task' && rec.status === 'retired';
  const [name, rest] = splitName(body);
  const managedRe = kind === 'milestone' ? MS_MANAGED : TASK_MANAGED;
  const segment = kind === 'milestone' ? msSegment(rec) : taskSegment(rec, retired);

  const changes = [];

  let newName = name;
  const forgeName = String(rec.name || '').trim();
  // A vault-only *(annotation)* after the name is yours; it only counts as a rename
  // when the name itself differs.
  const bare = (x) => x.replace(/\s*\*\([^)]*\)\*/g, '').replace(/\s+/g, ' ').trim();
  if (opts.syncNames !== false && forgeName && bare(name) !== bare(forgeName)) {
    newName = forgeName;
    changes.push(`name: “${name.trim().slice(0, 60)}” → “${forgeName.slice(0, 60)}”`);
  }

  let newRest = applyManaged(rest, managedRe, segment);

  const oldSeg = managedOf(rest, managedRe);
  if (oldSeg !== segment) changes.push(`${oldSeg || '∅'} → ${segment || '∅'}`);

  let newMarker = marker;
  if (kind === 'task') {
    if (retired) {
      newMarker = '-';
      if (!CANCEL_DATE.test(newRest) && ISO_DATE.test(rec.flagDate || '')) newRest += ` ❌ ${rec.flagDate}`;
    } else if (marker === '-') {
      newMarker = ' ';
      newRest = newRest.replace(CANCEL_DATE, '');
    }
    if (newMarker !== marker) changes.push(retired ? 'retired → cancelled [-]' : 'un-retired → reopened');
  }

  const after = `${prefix}${newMarker}${close}${newName}${newRest}`;
  if (after === line) return { after: line, changes: [] };
  return { after, changes };
}

function formatTaskLine(rec) {
  const seg = taskSegment(rec, false);
  return `- [ ] ${rec.name}${seg ? ' ' + seg : ''} 🆔 ${rec.id}`;
}

function formatMilestoneLine(rec) {
  const seg = msSegment(rec);
  return `- [ ] ${rec.name}${seg ? ' ' + seg : ''} 🆔 ${rec.id}`;
}

/* ── Plugin ── */

class ForgeSyncPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // v0.2 rewrites far more than completions. Anyone upgrading from an older
    // saved config gets Preview mode forced back on once, so the first run is a report.
    if ((saved.settingsVersion || 1) < SETTINGS_VERSION) {
      this.settings.dryRun = true;
      this.settings.settingsVersion = SETTINGS_VERSION;
      await this.saveSettings();
    }

    this.addRibbonIcon('hammer', 'Pull from Forge', () => this.run());

    this.addCommand({
      id: 'pull-from-forge',
      name: 'Pull from Forge (completions + metadata)',
      callback: () => this.run(),
    });

    this.addSettingTab(new ForgeSyncSettingTab(this.app, this));
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* ── Remote state ── */

  async fetchSyncFile() {
    const url = this.settings.syncUrl.trim();
    if (!url) throw new Error('No sync URL set. Open Forge Sync settings.');

    const busted = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
    const res = await requestUrl({ url: busted, method: 'GET', throw: false });

    if (res.status === 404) throw new Error('forge-sync.json not found at that URL.');
    if (res.status !== 200) throw new Error(`Fetch failed: HTTP ${res.status}`);

    let json;
    try {
      json = typeof res.json === 'object' ? res.json : JSON.parse(res.text);
    } catch (e) {
      throw new Error('Sync file is not valid JSON.');
    }
    if (json.version !== 1) throw new Error(`Unsupported sync file version: ${json.version}`);
    return json;
  }

  /* ── Index Forge records by id. Returns { byId, kindById } ── */

  indexForge(json) {
    const byId = new Map();
    const kindById = new Map();
    const tombstones = new Set(); // ids deleted in Forge
    const sources = [
      ['task', json.tasks],
      ['milestone', json.milestones],
      ['rune', json.runes],
    ];
    for (const [kind, collection] of sources) {
      if (!Array.isArray(collection)) continue;
      for (const rec of collection) {
        if (!rec || !rec.id) continue;
        if (rec.deleted) {
          tombstones.add(String(rec.id));
          continue;
        }
        byId.set(String(rec.id), rec);
        kindById.set(String(rec.id), kind);
      }
    }
    // A live record always wins over a tombstone with the same id.
    for (const id of byId.keys()) tombstones.delete(id);
    return { byId, kindById, tombstones };
  }

  /* ── Vault scan ── */

  isExcluded(path) {
    const parts = this.settings.excludeFolders
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.some((p) => path === p || path.startsWith(p + '/') || path.includes('/' + p + '/'));
  }

  isMetadataFile(path) {
    const bare = path.replace(/\.md$/i, '');
    return this.settings.metadataFiles
      .split(',')
      .map((s) => s.trim().replace(/\.md$/i, ''))
      .filter(Boolean)
      .some((p) => bare === p);
  }

  async scanVault() {
    const files = this.app.vault.getMarkdownFiles().filter((f) => !this.isExcluded(f.path));
    const hits = [];

    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = TASK_LINE.exec(lines[i]);
        if (!m) continue;
        const body = m[4];
        const idm = ID_TAG.exec(body);
        if (!idm) continue;
        hits.push({
          file,
          lineNo: i,
          id: idm[1],
          marker: m[2],
          state: m[2] === '-' ? 'cancelled' : m[2] === ' ' ? 'open' : 'done',
          idCount: (body.match(ID_TAG_ALL) || []).length,
          line: lines[i],
          text: body,
        });
      }
    }
    return hits;
  }

  /* ── Plan ── */

  buildPlan(hits, index, now = new Date()) {
    const { byId: forgeById, kindById } = index;
    const tombstones = index.tombstones || new Set();
    const counts = new Map();
    const metaCounts = new Map(); // duplicates that matter for metadata: within the metadata files only
    for (const h of hits) {
      counts.set(h.id, (counts.get(h.id) || 0) + 1);
      if (this.isMetadataFile(h.file.path)) metaCounts.set(h.id, (metaCounts.get(h.id) || 0) + 1);
    }

    const plan = {
      toApply: [], // completion check-offs
      toUpdate: [], // metadata rewrites
      duplicates: [],
      ambiguous: [],
      conflicts: [],
      vaultAhead: [],
      unmatched: [],
      deletedOpen: [],
      missing: { tasks: [], milestones: [] },
      alreadyInSync: 0,
    };

    for (const h of hits) {
      const rec = forgeById.get(h.id);

      if (!rec) {
        if (tombstones.has(h.id)) {
          // Deleted in Forge. A cancelled/done line is consistent; an open one needs a look.
          if (h.state === 'open') plan.deletedOpen.push(h);
          else plan.alreadyInSync++;
        } else {
          plan.unmatched.push(h);
        }
        continue;
      }

      const forgeDone = !!rec.completed;

      if (h.state === 'done') {
        if (forgeDone) plan.alreadyInSync++;
        else plan.vaultAhead.push(h);
        continue;
      }

      if (h.state === 'cancelled' && forgeDone) {
        plan.alreadyInSync++;
        continue;
      }

      // Open here, done in Forge — a candidate completion write.
      if (h.state === 'open' && forgeDone) {
        if (counts.get(h.id) > 1) {
          plan.duplicates.push(h);
          continue;
        }
        if (INLINE_COMPLETION.test(h.text)) {
          plan.conflicts.push(h);
          continue;
        }
        const date = ISO_DATE.test(rec.completedAt || '') ? rec.completedAt : todayISO();
        const m = TASK_LINE.exec(h.line);
        let body = m[4].replace(/\s+$/, '');
        if (!DONE_MARKER.test(body)) body += ` ✅ ${date}`;
        plan.toApply.push({ ...h, date, before: h.line, after: `${m[1]}x${m[3]}${body}` });
        continue;
      }

      // Open/cancelled here, not done in Forge — metadata candidate.
      const kind = kindById.get(h.id);
      const eligible =
        this.settings.syncMetadata &&
        (kind === 'task' || kind === 'milestone') &&
        this.isMetadataFile(h.file.path);

      if (!eligible) {
        plan.alreadyInSync++;
        continue;
      }
      if (metaCounts.get(h.id) > 1) {
        plan.duplicates.push(h);
        continue;
      }
      if (h.idCount > 1) {
        plan.ambiguous.push(h);
        continue;
      }

      const { after, changes } = rewriteLine(h.line, rec, kind, { syncNames: this.settings.syncNames });
      if (after === h.line) {
        plan.alreadyInSync++;
      } else {
        plan.toUpdate.push({ ...h, kind, before: h.line, after, changes });
      }
    }

    // Forge items with no line in the metadata files (current Greek month onward).
    if (this.settings.syncMetadata) {
      const present = new Set(hits.filter((h) => this.isMetadataFile(h.file.path)).map((h) => h.id));
      const cur = greekMonthOf(now);
      for (const [id, rec] of forgeById) {
        const kind = kindById.get(id);
        if (present.has(id) || rec.completed) continue;
        const mn = monthNum(rec.month) || (rec.dueDate ? monthNum(greekMonthTagOf(rec.dueDate)) : 0);
        if (!mn || mn < cur) continue;
        if (kind === 'task' && rec.status !== 'retired') plan.missing.tasks.push(rec);
        else if (kind === 'milestone') plan.missing.milestones.push(rec);
      }
      const byDue = (a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.id.localeCompare(b.id);
      plan.missing.tasks.sort(byDue);
      plan.missing.milestones.sort(byDue);
    }

    return plan;
  }

  /* ── Write ── */

  async applyPlan(plan) {
    const byFile = new Map();
    for (const item of [...plan.toApply, ...plan.toUpdate]) {
      if (!byFile.has(item.file.path)) byFile.set(item.file.path, { file: item.file, items: [] });
      byFile.get(item.file.path).items.push(item);
    }

    const result = { completed: 0, updated: 0, stale: 0 };

    for (const { file, items } of byFile.values()) {
      await this.app.vault.process(file, (data) => {
        const lines = data.split('\n');
        for (const it of items) {
          // Re-verify: the line must be exactly what we planned against.
          if (lines[it.lineNo] !== it.before) {
            result.stale++;
            continue;
          }
          lines[it.lineNo] = it.after;
          if (it.date) result.completed++;
          else result.updated++;
        }
        return lines.join('\n');
      });
    }

    return result;
  }

  /* ── Entry point ── */

  async run() {
    const notice = new Notice('Forge Sync: fetching…', 0);
    try {
      const json = await this.fetchSyncFile();
      const index = this.indexForge(json);
      const hits = await this.scanVault();
      const plan = this.buildPlan(hits, index);

      let result = { completed: 0, updated: 0, stale: 0 };
      if (!this.settings.dryRun) {
        result = await this.applyPlan(plan);
      }

      notice.hide();
      new ForgeReportModal(this.app, {
        plan,
        result,
        dryRun: this.settings.dryRun,
        scanned: hits.length,
        lastUpdated: json.lastUpdated,
        updatedBy: json.updatedBy,
      }).open();
    } catch (err) {
      notice.hide();
      new Notice(`Forge Sync: ${err.message}`, 8000);
      console.error('[forge-sync]', err);
    }
  }
}

module.exports = ForgeSyncPlugin;
// Exposed for the test suite; Obsidian ignores extra properties.
module.exports._internals = {
  TASK_LINE,
  splitName,
  applyManaged,
  taskSegment,
  msSegment,
  rewriteLine,
  formatTaskLine,
  formatMilestoneLine,
  greekMonthOf,
  greekMonthTagOf,
  isoWeekTagOf,
  DEFAULT_SETTINGS,
};

/* ─────────────────────────────────────────────────────────────
   Report
   ───────────────────────────────────────────────────────────── */

class ForgeReportModal extends Modal {
  constructor(app, data) {
    super(app);
    this.data = data;
  }

  onOpen() {
    const { contentEl } = this;
    const { plan, result, dryRun, scanned, lastUpdated, updatedBy } = this.data;

    contentEl.createEl('h2', { text: dryRun ? 'Forge Sync — preview' : 'Forge Sync — applied' });

    const meta = contentEl.createEl('p');
    meta.style.opacity = '0.7';
    meta.style.fontSize = '0.85em';
    meta.setText(
      `${scanned} tagged lines scanned · sync file updated ${lastUpdated || 'unknown'} by ${updatedBy || 'unknown'}`
    );

    const banner = contentEl.createEl('p');
    banner.style.fontWeight = '600';
    if (dryRun) {
      banner.setText(
        `Preview only — nothing was written. ${plan.toApply.length} line(s) would be checked off, ${plan.toUpdate.length} would be updated. Turn off Preview mode in settings to apply.`
      );
    } else {
      const stale = result.stale ? ` ${result.stale} line(s) changed since the scan and were skipped — run again.` : '';
      banner.setText(`${result.completed} line(s) checked off, ${result.updated} updated.${stale}`);
    }

    const MAX = 60;
    const section = (title, items, render) => {
      if (!items.length) return;
      contentEl.createEl('h3', { text: `${title} (${items.length})` });
      const ul = contentEl.createEl('ul');
      ul.style.fontSize = '0.9em';
      for (const it of items.slice(0, MAX)) {
        ul.createEl('li', { text: render(it) });
      }
      if (items.length > MAX) {
        ul.createEl('li', { text: `…and ${items.length - MAX} more` });
      }
    };

    const label = (it) => {
      const name = it.text.replace(ID_TAG, '').replace(/#\S+/g, '').trim();
      return `${it.id} — ${name.slice(0, 70)} (${it.file.basename})`;
    };

    section(dryRun ? 'Would check off' : 'Checked off', plan.toApply, (it) => `${label(it)} → ✅ ${it.date}`);

    section(
      dryRun ? 'Would update from Forge' : 'Updated from Forge',
      plan.toUpdate,
      (it) => `${it.id} · ${it.changes.join(' · ')}`
    );

    section(
      'Skipped — same ID on multiple lines',
      plan.duplicates,
      (it) => `${label(it)} · line ${it.lineNo + 1}`
    );

    section(
      'Skipped — more than one 🆔 on the line',
      plan.ambiguous,
      (it) => `${label(it)} · line ${it.lineNo + 1}`
    );

    section(
      'Skipped — inline [completion::] would override the date',
      plan.conflicts,
      label
    );

    section(
      'Done here, still open in Forge — fix in Forge',
      plan.vaultAhead,
      label
    );

    section('Deleted in Forge, still open here — cancel or delete the line', plan.deletedOpen, label);

    section('No matching Forge record', plan.unmatched, label);

    this.missingBlock('Master Priority List', plan.missing.tasks, formatTaskLine);
    this.missingBlock('Master Milestones', plan.missing.milestones, formatMilestoneLine);

    const footer = contentEl.createEl('p');
    footer.style.opacity = '0.7';
    footer.style.fontSize = '0.85em';
    footer.setText(`${plan.alreadyInSync} line(s) already in sync.`);
  }

  missingBlock(fileName, recs, fmt) {
    if (!recs.length) return;
    const { contentEl } = this;
    contentEl.createEl('h3', { text: `In Forge, not in ${fileName} (${recs.length})` });
    const p = contentEl.createEl('p');
    p.style.fontSize = '0.85em';
    p.style.opacity = '0.7';
    p.setText('Paste these under the right goal heading. The plugin never inserts or moves lines.');

    const text = recs.map(fmt).join('\n');
    const ta = contentEl.createEl('textarea');
    ta.value = text;
    ta.readOnly = true;
    ta.style.width = '100%';
    ta.style.minHeight = '9em';
    ta.style.fontSize = '0.8em';

    const btn = contentEl.createEl('button', { text: 'Copy lines' });
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        new Notice(`Copied ${recs.length} line(s).`);
      } catch (e) {
        ta.select();
        new Notice('Select-all done — copy manually.');
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ─────────────────────────────────────────────────────────────
   Settings
   ───────────────────────────────────────────────────────────── */

class ForgeSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const toggle = (name, desc, key) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(this.plugin.settings[key]).onChange(async (v) => {
            this.plugin.settings[key] = v;
            await this.plugin.saveSettings();
          })
        );

    const text = (name, desc, key) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t
            .setPlaceholder(DEFAULT_SETTINGS[key])
            .setValue(this.plugin.settings[key])
            .onChange(async (v) => {
              this.plugin.settings[key] = v;
              await this.plugin.saveSettings();
            })
        );

    toggle(
      'Preview mode',
      'Show what would change without writing to any file. Leave on until a preview looks right.',
      'dryRun'
    );
    toggle(
      'Sync metadata',
      'Rewrite due dates, month/week tags, priority, goal and retired state on open lines in the metadata files. Off = completions only.',
      'syncMetadata'
    );
    toggle(
      'Sync task names',
      'Also rewrite the task name from Forge. Turn off if you keep your own wording or notes in the name part of a line.',
      'syncNames'
    );
    text(
      'Metadata files',
      'Comma-separated vault paths (no .md) where metadata is rewritten. Completions apply everywhere.',
      'metadataFiles'
    );
    text('Sync file URL', 'Raw URL of forge-sync.json.', 'syncUrl');
    text(
      'Skip folders',
      'Comma-separated folder names to leave untouched, so archived copies never get rewritten.',
      'excludeFolders'
    );
  }
}
