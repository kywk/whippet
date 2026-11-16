import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, object, strictJSON, uuid } from './safety.js';

function parent(path: string) {
  if (!isAbsolute(path)) throw new BridgeError('state_unavailable');
  const item = lstatSync(dirname(path));
  if (!item.isDirectory() || item.uid !== process.getuid?.() || (item.mode & 0o777) !== 0o700) throw new BridgeError('state_unavailable');
}
export function readPrivate(path: string, maximum: number): string {
  let fd: number | undefined;
  try {
    parent(path);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const item = fstatSync(fd);
    if (!item.isFile() || item.uid !== process.getuid?.() || item.nlink !== 1 || (item.mode & 0o777) !== 0o600 || item.size > maximum) throw new Error();
    const text = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(text) > maximum) throw new Error();
    return text;
  } catch { throw new BridgeError('secret_file_unavailable'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function readToken(path: string): string {
  const token = readPrivate(path, 8193).replace(/\r?\n$/, '');
  if (!token || token.length > 8192 || !/^[\x21-\x7e]+$/.test(token)) throw new BridgeError('secret_file_unavailable');
  return token;
}
export interface Identity { runId: string; attemptId: string; leaseId: string }
export interface Journal {
  schemaVersion: 1; url: string; tokenHash: string; requestId: string;
  phase: 'claiming' | 'claimed' | 'submitting' | 'submitted' | 'idle';
  task?: Identity;
  submit?: Identity & { submitId: string; output: Record<string, unknown> };
  result?: Record<string, unknown>;
}
export class PrivateState {
  private owner?: string;
  constructor(readonly path: string) {}
  lock() {
    try {
      parent(this.path);
      const fd = openSync(this.path + '.lock', 'wx', 0o600);
      this.owner = randomUUID();
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, owner: this.owner })); fsyncSync(fd); } finally { closeSync(fd); }
    } catch { throw new BridgeError('state_busy'); }
  }
  unlock() {
    if (this.owner) {
      try {
        if (object(strictJSON(readPrivate(this.path + '.lock', 1024))).owner === this.owner) unlinkSync(this.path + '.lock');
      } finally { this.owner = undefined; }
    }
  }
  read(): Journal | undefined {
    try { lstatSync(this.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new BridgeError('state_unavailable'); }
    const value = object(strictJSON(readPrivate(this.path, 13 * 1024 * 1024)));
    if (value.schemaVersion !== 1 || !uuid(value.requestId) || !['claiming', 'claimed', 'submitting', 'submitted', 'idle'].includes(value.phase) ||
      Object.keys(value).some(key => !['schemaVersion', 'url', 'tokenHash', 'requestId', 'phase', 'task', 'submit', 'result'].includes(key))) throw new BridgeError('state_unavailable');
    if (value.task && !['runId', 'attemptId', 'leaseId'].every(key => uuid(value.task[key]))) throw new BridgeError('state_unavailable');
    if (value.phase === 'submitting' && (!value.submit || !uuid(value.submit.submitId) || !value.task || !['runId', 'attemptId', 'leaseId'].every(key => value.submit[key] === value.task[key]))) throw new BridgeError('state_unavailable');
    return value as Journal;
  }
  write(value: Journal) {
    if (!this.owner) throw new BridgeError('state_unavailable');
    const temporary = this.path + '.' + randomUUID();
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, this.path); }
    catch { unlinkSync(temporary); throw new BridgeError('state_unavailable'); }
    const directory = openSync(dirname(this.path), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
