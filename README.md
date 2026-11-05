# forge-sync-obsidian
Obsidian plugin: pulls task state from `forge-sync.json` (The Forge) and applies it to vault task lines matched by Tasks-plugin ID (`🆔`). One-way, Forge → Obsidian.

## What it does (v0.2)
- **Completions** (any note): open here + done in Forge → checked off with `✅ date`.
- **Metadata** (only the files in *Metadata files*, default Master Priority List + Master Milestones): open lines are rewritten in place from Forge.
  - Tasks: name, `[due:: D]`, `#Qn #Mnn #Wnn`, `#High/#Mid/#Low`, `#Gn`. Month/week come from Forge, or are derived from the due date (Greek month, ISO week) when blank. No due date → date and month/week tags removed (on hold).
  - Retired tasks become `[-] … ❌ date` and lose date/month/week tags; un-retiring reopens them.
  - Milestones: name, `` `due:: D` (@D) ``, `#MSnn #MSWnn`, `#Gn`. `#Ln` is never touched.
  - Unmanaged text (🆔, notes, `*(annotations)*`, other tags) stays as-is. Done (`[x]`) lines are never rewritten.
- **Missing lines**: Forge tasks/milestones from the current Greek month onward with no line in the metadata files are listed with paste-ready lines and a Copy button. The plugin never inserts, moves or deletes lines.
- **Skipped and reported**: same ID on several lines (within the metadata files), more than one `🆔` on a line, inline `[completion::]`, done-here/open-in-Forge, no matching Forge record.

Preview mode is on by default — nothing is written until you turn it off in settings. A line that changed between scan and write is skipped, never overwritten.

## Settings
Preview mode · Sync metadata · Sync task names · Metadata files · Sync file URL · Skip folders

## Tests
`node test/run-tests.js` (no dependencies).
