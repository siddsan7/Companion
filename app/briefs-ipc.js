const { Briefs } = require('./briefs');
function installBriefs({ ipcMain, dialog, fs, path, testRoot, getVault, clock }) {
  let selected = [], chain = Promise.resolve();
  const store = () => { const vault = getVault(); if (!vault) throw Error('Choose a vault first.'); return new Briefs(vault); };
  const serial = work => { const next = chain.then(work); chain = next.catch(() => {}); return next; };
  ipcMain.handle('brief-select', async (_, mode) => {
    const files = testRoot ? JSON.parse(await fs.readFile(path.join(testRoot, 'brief-selection.json'), 'utf8')) : (await dialog.showOpenDialog({ title: mode === 'readme' ? 'Select current MyTune README' : 'Add selected project documents', properties: ['openFile', ...(mode === 'readme' ? [] : ['multiSelections'])], filters: [{ name: 'Project documents', extensions: ['md', 'txt'] }] })).filePaths;
    if (files.length) selected = mode === 'readme' ? files.slice(0, 1) : [...new Set([...selected, ...files])];
    return selected;
  });
  ipcMain.handle('brief-state', async () => {
    if (!getVault()) return { approved: [], selected: [], issues: [], proposalIssues: [] };
    const state = await store().state();
    if (!selected.length) selected = (state.proposed || state.approved[0])?.sources.map(s => s.path) || [];
    return { ...state, selected };
  });
  ipcMain.handle('brief-propose', () => serial(() => store().propose(selected, clock().now)));
  ipcMain.handle('brief-approve', (_, input) => serial(async () => {
    const state = await store().state();
    if (JSON.stringify(selected) !== JSON.stringify(state.proposed?.sources.map(s => s.path))) throw Error('Source selection changed. Propose and inspect a new brief first.');
    return store().approve(input, clock().now);
  }));
  ipcMain.handle('brief-pin', (_, version) => store().pinned(version));
}
module.exports = { installBriefs };
