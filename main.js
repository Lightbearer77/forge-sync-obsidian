'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, Modal, requestUrl } = require('obsidian');

/* ─────────────────────────────────────────────────────────────
   Forge Sync — one-way pull: forge-sync.json → vault task lines.

   Contract:
     · Forge is the write surface. This plugin never sends anything
       back; it only applies Forge's completion state to the vault.
     · Lines are matched by the Tasks plugin's native ID field
       (🆔 <id>) against task/milestone ids in forge-sync.json.
       No second ID system.
     · Completion is written as the Tasks marker (✅ YYYY-MM-DD).
       An inline [completion:: …] field on the same line would
       override that date in Dataview, so such lines are skipped
       and reported rather than silently written to.
     · A vault id appearing on more than one line is ambiguous.
       Those lines are skipped and reported — never guessed at.
     · Vault-ahead-of-Forge lines (done here, open there) are
       reported read-only. Fix those in Forge; this plugin will
       not un-check anything.
   ───────────────────────────────────────────────────────────── */

const DEFAULT_SETTINGS = {
  syncUrl: 'https://raw.githubusercontent.com/Lightbearer77/Forge/main/forge-sync.json',
  excludeFolders: 'Archive, Templates, .trash',
  dryRun: true,
};

const TASK_LINE = /^(\s*(?:[-*+])\s+\[)([ xX])(\]\s*)(.*)$/;
const ID_TAG = /🆔\s*([A-Za-z0-9_\-]+)/;
const DONE_MARKER = /✅\s*\d{4}-\d{2}-\d{2}/;
const INLINE_COMPLETION = /\[completion::\s*[^\]]*\]/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const todayISO = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

module.exports = class ForgeSyncPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.addRibbonIcon('hammer', 'Pull from Forge', () => this.run());

    this.addCommand({
      id: 'pull-from-forge',
      name: 'Pull completions from Forge',
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

  /* ── Index Forge records by id (tasks + milestones share the shape) ── */

  indexForge(json) {
    const byId = new Map();
    for (const collection of [json.tasks, json.milestones, json.runes]) {
      if (!Array.isArray(collection)) continue;
      for (const rec of collection) {
        if (!rec || !rec.id || rec.deleted) continue;
        byId.set(String(rec.id), rec);
      }
    }
    return byId;
  }

  /* ── Vault scan ── */

  isExcluded(path) {
    const parts = this.settings.excludeFolders
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.some((p) => path === p || path.startsWith(p + '/') || path.includes('/' + p + '/'));
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
          checked: m[2] !== ' ',
          text: body,
        });
      }
    }
    return hits;
  }

  /* ── Plan ── */

  buildPlan(hits, forgeById) {
    const counts = new Map();
    for (const h of hits) counts.set(h.id, (counts.get(h.id) || 0) + 1);

    const plan = {
      toApply: [],
      duplicates: [],
      conflicts: [],
      vaultAhead: [],
      unmatched: [],
      alreadyInSync: 0,
    };

    for (const h of hits) {
      const rec = forgeById.get(h.id);

      if (!rec) {
        plan.unmatched.push(h);
        continue;
      }

      const forgeDone = !!rec.completed;

      if (h.checked && !forgeDone) {
        plan.vaultAhead.push(h);
        continue;
      }
      if (h.checked && forgeDone) {
        plan.alreadyInSync++;
        continue;
      }
      if (!h.checked && !forgeDone) {
        plan.alreadyInSync++;
        continue;
      }

      // Open here, done in Forge — a candidate write.
      if (counts.get(h.id) > 1) {
        plan.duplicates.push(h);
        continue;
      }
      if (INLINE_COMPLETION.test(h.text)) {
        plan.conflicts.push(h);
        continue;
      }

      const date = ISO_DATE.test(rec.completedAt || '') ? rec.completedAt : todayISO();
      plan.toApply.push({ ...h, date });
    }

    return plan;
  }

  /* ── Write ── */

  async applyPlan(plan) {
    const byFile = new Map();
    for (const item of plan.toApply) {
      if (!byFile.has(item.file.path)) byFile.set(item.file.path, { file: item.file, items: [] });
      byFile.get(item.file.path).items.push(item);
    }

    let written = 0;

    for (const { file, items } of byFile.values()) {
      const wanted = new Map(items.map((it) => [it.lineNo, it]));

      await this.app.vault.process(file, (data) => {
        const lines = data.split('\n');
        for (const [lineNo, it] of wanted) {
          const line = lines[lineNo];
          if (line === undefined) continue;

          const m = TASK_LINE.exec(line);
          if (!m) continue;
          // Re-verify: the line must still be open and still carry the same id.
          if (m[2] !== ' ') continue;
          const idm = ID_TAG.exec(m[4]);
          if (!idm || idm[1] !== it.id) continue;

          let body = m[4].replace(/\s+$/, '');
          if (!DONE_MARKER.test(body)) body += ` ✅ ${it.date}`;

          lines[lineNo] = `${m[1]}x${m[3]}${body}`;
          written++;
        }
        return lines.join('\n');
      });
    }

    return written;
  }

  /* ── Entry point ── */

  async run() {
    const notice = new Notice('Forge Sync: fetching…', 0);
    try {
      const json = await this.fetchSyncFile();
      const forgeById = this.indexForge(json);
      const hits = await this.scanVault();
      const plan = this.buildPlan(hits, forgeById);

      let written = 0;
      if (!this.settings.dryRun) {
        written = await this.applyPlan(plan);
      }

      notice.hide();
      new ForgeReportModal(this.app, {
        plan,
        written,
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
    const { plan, written, dryRun, scanned, lastUpdated, updatedBy } = this.data;

    contentEl.createEl('h2', { text: dryRun ? 'Forge Sync — preview' : 'Forge Sync — applied' });

    const meta = contentEl.createEl('p');
    meta.style.opacity = '0.7';
    meta.style.fontSize = '0.85em';
    meta.setText(
      `${scanned} tagged lines scanned · sync file updated ${lastUpdated || 'unknown'} by ${updatedBy || 'unknown'}`
    );

    if (dryRun) {
      const banner = contentEl.createEl('p');
      banner.style.fontWeight = '600';
      banner.setText(
        `Preview only — nothing was written. ${plan.toApply.length} line(s) would be checked off. Turn off Preview mode in settings to apply.`
      );
    } else {
      const banner = contentEl.createEl('p');
      banner.style.fontWeight = '600';
      banner.setText(`${written} line(s) checked off.`);
    }

    const section = (title, items, render) => {
      if (!items.length) return;
      contentEl.createEl('h3', { text: `${title} (${items.length})` });
      const ul = contentEl.createEl('ul');
      ul.style.fontSize = '0.9em';
      for (const it of items.slice(0, 40)) {
        ul.createEl('li', { text: render(it) });
      }
      if (items.length > 40) {
        ul.createEl('li', { text: `…and ${items.length - 40} more` });
      }
    };

    const label = (it) => {
      const name = it.text.replace(ID_TAG, '').replace(/#\S+/g, '').trim();
      return `${it.id} — ${name.slice(0, 70)} (${it.file.basename})`;
    };

    section(dryRun ? 'Would check off' : 'Checked off', plan.toApply, (it) => `${label(it)} → ✅ ${it.date}`);

    section(
      'Skipped — same ID on multiple lines',
      plan.duplicates,
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

    section('No matching Forge record', plan.unmatched, label);

    const footer = contentEl.createEl('p');
    footer.style.opacity = '0.7';
    footer.style.fontSize = '0.85em';
    footer.setText(`${plan.alreadyInSync} line(s) already in sync.`);
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

    new Setting(containerEl)
      .setName('Preview mode')
      .setDesc('Show what would change without writing to any file. Leave on until a preview looks right.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.dryRun).onChange(async (v) => {
          this.plugin.settings.dryRun = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Sync file URL')
      .setDesc('Raw URL of forge-sync.json.')
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.syncUrl)
          .setValue(this.plugin.settings.syncUrl)
          .onChange(async (v) => {
            this.plugin.settings.syncUrl = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Skip folders')
      .setDesc('Comma-separated folder names to leave untouched, so archived copies never get rewritten.')
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.excludeFolders)
          .setValue(this.plugin.settings.excludeFolders)
          .onChange(async (v) => {
            this.plugin.settings.excludeFolders = v;
            await this.plugin.saveSettings();
          })
      );
  }
}
