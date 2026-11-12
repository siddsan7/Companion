# Electron desktop capture and Markdown authority

Use Electron 45.2.3, plain JavaScript, YAML 2.9.1 and Playwright 1.65.0 with npm's committed lockfile. This supplies a real Windows desktop shell and a single acceptance harness without adding a UI framework or database. Versions were checked against the registry during implementation. YAML supports normal Obsidian property edits without requiring JSON-style quoting in frontmatter.

The main process owns filesystem access, folder selection, local settings and Obsidian dispatch. The sandboxed renderer uses a narrow preload bridge with context isolation, CSP and blocked network/navigation. Vault Markdown is authoritative; the capture list is rebuilt from files. The current schema carries stable identities, capture type, schema version, absolute capture time and explicit excerpt provenance. Artifact areas are separate from the first write.

Tests drive the real desktop UI and inspect resulting Markdown across restart. They substitute OS folder selection, time/timezone and URI dispatch at process boundaries. Real Obsidian dispatch and later producer/Codex/scheduler gates remain separate integration checks. The test seam was approved in the parent spec before implementation.

Trade-offs: Electron adds a runtime download and memory cost. Plain JavaScript keeps this initial workflow small but needs explicit validation at IPC and filesystem boundaries. Markdown avoids a second content authority. In-place title updates retain recovery backups and refuse detected external changes; full identity repair and import journaling are later slices.
