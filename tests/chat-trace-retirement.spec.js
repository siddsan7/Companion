const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openTrace, observe, retireTrace } = require('../scripts/chat-trace-retirement.cjs');

for (const scenario of ['normal', 'swapped-root', 'replaced-file', 'modified-file', 'extra-entry', 'interrupted']) {
  test('trace retirement preserves ownership: ' + scenario, () => {
    const staging = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'companion-live-chat-'));
    const root = fs.mkdtempSync(path.join(staging, 'synthetic-trace-'));
    const bundle = 'trace-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002';
    const info = path.join(bundle, 'manifest.json'), events = path.join(bundle, 'trace.jsonl');
    const file = path.join(root, info), log = path.join(root, events);
    try {
      const trace = openTrace(root);
      fs.mkdirSync(path.join(root, bundle)); observe(trace, bundle, true);
      fs.writeFileSync(file, '{"fixture":1}'); observe(trace, info);
      fs.writeFileSync(log, 'fixture event'); observe(trace, events);
      if (scenario === 'normal') {
        retireTrace(trace);
        expect(fs.existsSync(root)).toBe(false);
        return;
      }
      if (scenario === 'swapped-root') {
        const moved = path.join(staging, 'moved');
        fs.renameSync(root, moved); fs.mkdirSync(root);
        const sentinel = path.join(root, 'sentinel');
        fs.writeFileSync(sentinel, 'foreign');
        expect(() => retireTrace(trace)).toThrow(/cleanup incomplete/);
        expect(fs.readFileSync(sentinel, 'utf8')).toBe('foreign');
        expect(fs.readFileSync(path.join(moved, info), 'utf8')).toBe('{"fixture":1}');
        return;
      }
      if (scenario === 'replaced-file') {
        fs.renameSync(file, path.join(staging, 'original'));
        fs.writeFileSync(file, '{"fixture":1}');
      }
      if (scenario === 'modified-file') fs.writeFileSync(file, 'foreign bytes');
      if (scenario === 'extra-entry') fs.writeFileSync(path.join(root, bundle, 'sentinel'), 'foreign');
      if (scenario === 'interrupted') {
        // Windows keeps the deleted log pending until its other reader releases the handle.
        const held = fs.openSync(log, 'r');
        try {
          expect(() => retireTrace(trace)).toThrow(/cleanup incomplete/);
          expect(fs.existsSync(file)).toBe(false);
          expect(fs.readFileSync(held, 'utf8')).toBe('fixture event');
        } finally { fs.closeSync(held); }
        fs.writeFileSync(file, 'foreign after interruption');
        expect(() => retireTrace(trace)).toThrow(/cleanup incomplete/);
        expect(fs.readFileSync(file, 'utf8')).toBe('foreign after interruption');
        return;
      }
      expect(() => retireTrace(trace)).toThrow(/cleanup incomplete/);
      expect(fs.readFileSync(file, 'utf8')).toBe(scenario === 'modified-file' ? 'foreign bytes' : '{"fixture":1}');
      expect(fs.readFileSync(log, 'utf8')).toBe('fixture event');
      if (scenario === 'extra-entry') expect(fs.readFileSync(path.join(root, bundle, 'sentinel'), 'utf8')).toBe('foreign');
    } finally {
      // This fixture owns the entire staging tree, including the simulated foreign files.
      expect(path.dirname(fs.realpathSync.native(staging))).toBe(fs.realpathSync.native(os.tmpdir()));
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });
}
