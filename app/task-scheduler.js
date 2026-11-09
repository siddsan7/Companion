const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
// Microsoft CommandLineToArgvW quoting. Shell interpretation is never involved.
function argv(value) {
  if (/[\x00-\x1f]/.test(value)) throw Error('Unsupported control character in task path.');
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}
class TaskScheduler {
  constructor({ testRoot, executable = process.execPath, appPath = path.resolve(__dirname, '..'), packaged = false } = {}) { Object.assign(this, { testRoot, executable, appPath, packaged }); }
  request(operation, state, file) {
    const args = [...(this.packaged ? [] : [this.appPath]), '--intake-worker', '--schedule-file', file];
    // Task Scheduler truncates subsecond boundaries. Round upward so its
    // launch cannot precede the exact application deadline. Preserve the anchor.
    return { operation, name: `Companion-${state.id}`, owner: `Companion daily intake ${state.id}`, executable: this.executable, arguments: args.map(argv).join(' '), directory: this.appPath, firstDue: new Date(Math.ceil((Date.parse(state.anchor) + 86400000) / 1000) * 1000).toISOString(), interval: 'PT24H', triggerCount: 1, triggerType: 1, triggerEnabled: true, repetitionDuration: '', endBoundary: '', stopAtDurationEnd: false, startWhenAvailable: true, wakeToRun: false, multipleInstances: 2, enabled: state.mode === 'enabled' };
  }
  matchesSchedule(task, state, file) {
    if (!task) return false;
    const expected = this.request('inspect', state, file);
    const fields = ['triggerCount', 'triggerType', 'triggerEnabled', 'repetitionDuration', 'endBoundary', 'stopAtDurationEnd', 'startWhenAvailable', 'wakeToRun', 'multipleInstances'];
    return fields.every(field => task[field] === expected[field]) &&
      ['PT24H', 'P1D'].includes(task.interval) &&
      typeof task.firstDue === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(task.firstDue) &&
      Date.parse(task.firstDue) === Date.parse(expected.firstDue);
  }
  async apply(operation, state, file) {
    const request = this.request(operation, state, file);
    if (this.testRoot && !process.env.COMPANION_NATIVE_SCHEDULER) {
      const taskFile = path.join(this.testRoot, 'scheduler-task.json');
      let task = null, control = {};
      try { task = JSON.parse(await fs.readFile(taskFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { control = JSON.parse(await fs.readFile(path.join(this.testRoot, 'scheduler-control.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (control.fail === operation) throw Error('Windows task access denied (controlled OS boundary).');
      if (task && (task.name !== request.name || task.owner !== request.owner || task.executable !== request.executable || task.arguments !== request.arguments)) throw Error('Task ownership or launch action differs. Preserve the task and repair explicitly.');
      if (operation === 'inspect') return task;
      if (operation === 'disable') { await fs.unlink(taskFile).catch(error => { if (error.code !== 'ENOENT') throw error; }); return null; }
      if (!task && ['pause', 'resume'].includes(operation)) throw Error('Daily intake task is missing. Use Repair daily intake.');
      task = { ...request, enabled: operation === 'pause' ? false : operation === 'repair' ? request.enabled : true };
      await fs.writeFile(taskFile, JSON.stringify(task)); return task;
    }
    if (process.platform !== 'win32') throw Error('Windows Task Scheduler is required for daily intake.');
    return new Promise((resolve, reject) => {
      const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'task-scheduler.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.on('error', reject); child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => {
        try { const result = JSON.parse(stdout); if (code || result.error) reject(Error(result.error || stderr || 'Windows task operation failed.')); else resolve(result.task); }
        catch { reject(Error(`Windows task operation failed: ${stderr || stdout || code}`)); }
      });
      child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request));
    });
  }
}
module.exports = { TaskScheduler };
