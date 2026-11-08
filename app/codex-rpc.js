const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
// Private stdio transport. Never connect to a shared daemon or expose raw RPC to the renderer.
class CodexRpc extends EventEmitter {
  constructor(executable, args, options) {
    super(); this.pending = new Map(); this.sequence = 0; this.closed = false;
    this.child = spawn(executable, args, { ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    let buffer = '';
    this.child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 4 * 1024 * 1024) return this.close('Codex response exceeded the transport limit.');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message; try { message = JSON.parse(line); } catch { this.close('Codex sent an invalid response.'); return; }
        if (message.method && message.id !== undefined) {
          // No approvals, dynamic tools or permission changes are accepted.
          this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Companion does not permit server requests.' } }) + '\n');
          this.emit('violation', 'Codex requested an unselected capability.');
        } else if (message.id !== undefined) {
          const pending = this.pending.get(message.id); if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(message.id);
          // Error payloads can include local paths or provider identifiers. Keep them out of UI/history.
          if (message.error) pending.reject(Error(`Codex request failed (${message.error.code ?? 'unknown'}).`)); else pending.resolve(message.result);
        } else if (message.method) this.emit('notification', message.method, message.params);
      }
    });
    // Drain stderr without retaining it: provider/config errors can contain secrets.
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => this.close('Codex could not start. Check the installed executable.'));
    this.child.on('exit', () => this.close('Codex stopped. Run setup again.'));
    this.child.stdin.on('error', () => this.close('Codex connection closed.'));
  }
  request(method, params = {}, timeout = 30000) {
    if (this.closed) return Promise.reject(Error('Codex is disconnected.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('Codex request timed out.')); this.close('Codex request timed out.'); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  notify(method, params = {}) { if (!this.closed) this.child.stdin.write(JSON.stringify({ method, params }) + '\n'); }
  close(reason = 'Codex connection closed.') {
    if (this.closed) return; this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error(reason)); }
    this.pending.clear(); this.child.kill(); this.emit('closed', reason);
  }
}
module.exports = { CodexRpc };
