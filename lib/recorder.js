import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile, unlink, open } from 'node:fs/promises';
import { join, resolve, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export const SCHEMA = 'agent-run-recorder/v0.1';
const VERSION = '0.1.0';
const FILES = ['stdout.bin', 'stderr.bin', 'events.jsonl'];
const HEX = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const ADAPTERS = new Set(['generic-jsonl', 'codex', 'claude']);
const sha = b => createHash('sha256').update(b).digest('hex');
const line = o => JSON.stringify(o) + '\n';
const validTime = x => x === null || (typeof x === 'string' && ISO.test(x) && !Number.isNaN(Date.parse(x)));
const coverage = a => ({
  source_reported: a === 'generic-jsonl' ? 'producer_jsonl_records' : 'client_structured_stdout',
  recorder_observed: 'process_boundary_only',
  unknown_events: 'counted_and_preserved_in_private_raw',
  not_exposed: 'hidden_state_and_unreported_actions'
});

export function classify(adapter, obj) {
  const t = typeof obj?.type === 'string' ? obj.type : '';
  if (adapter === 'generic-jsonl') return ['session', 'assistant_output', 'tool_call', 'tool_result', 'error'].includes(t) ? t : 'unknown';
  if (adapter === 'codex') {
    if (['thread.started', 'turn.started', 'turn.completed'].includes(t)) return 'session';
    if (['error', 'turn.failed'].includes(t)) return 'error';
    if (['agent_message', 'reasoning'].includes(obj?.item?.type)) return 'assistant_output';
    if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(obj?.item?.type)) return t === 'item.completed' ? 'tool_result' : 'tool_call';
    return 'unknown';
  }
  if (adapter === 'claude') {
    if (t === 'system' || t === 'result') return obj?.is_error ? 'error' : 'session';
    if (t === 'assistant') return obj?.message?.content?.some?.(x => x?.type === 'tool_use') ? 'tool_call' : 'assistant_output';
    if (t === 'user') return 'tool_result';
    if (t === 'stream_event') {
      if (obj?.event?.type === 'content_block_start' && obj?.event?.content_block?.type === 'tool_use') return 'tool_call';
      if (obj?.event?.type === 'content_block_delta' && obj?.event?.delta?.type === 'text_delta') return 'assistant_output';
    }
  }
  return 'unknown';
}

export class EventBuilder {
  constructor(adapter, started, emit) {
    Object.assign(this, { adapter, started, emit, decoder: new StringDecoder('utf8'), pending: '', sourceLine: 0, count: 0, unknown: 0, hash: createHash('sha256') });
  }
  async add(kind, origin, sourceLine, payload) {
    const b = Buffer.from(line({ ordinal: ++this.count, kind, origin, source_stream: origin === 'source-reported' ? 'stdout' : null, source_line: sourceLine, payload }));
    this.hash.update(b); if (kind === 'unknown') this.unknown++;
    await this.emit(b);
  }
  async start() { await this.add('session', 'recorder-observed', null, { phase: 'start', at: this.started }); }
  async feed(chunk) {
    this.pending += this.decoder.write(chunk);
    let at;
    while ((at = this.pending.indexOf('\n')) >= 0) {
      const s = this.pending.slice(0, at); this.pending = this.pending.slice(at + 1);
      await this.parse(s);
    }
  }
  async parse(s) {
    this.sourceLine++;
    if (s.endsWith('\r')) s = s.slice(0, -1);
    if (!s) return;
    let obj, kind;
    try { obj = JSON.parse(s); kind = classify(this.adapter, obj); }
    catch { obj = { malformed_json: true, raw_line: s }; kind = 'unknown'; }
    await this.add(kind, 'source-reported', this.sourceLine, obj);
  }
  async finish(terminal) {
    this.pending += this.decoder.end();
    if (this.pending) await this.parse(this.pending);
    await this.add('session', 'recorder-observed', null, terminal);
    return { count: this.count, unknown: this.unknown, sha256: this.hash.digest('hex') };
  }
}

async function push(stream, b) { if (!stream.write(b)) await once(stream, 'drain'); }
async function close(stream) { stream.end(); await once(stream, 'finish'); }
async function info(path) {
  const h = createHash('sha256'); let bytes = 0;
  for await (const b of createReadStream(path)) { h.update(b); bytes += b.length; }
  return { sha256: h.digest('hex'), bytes };
}
async function init(base, adapter, cliVersion = null) {
  const dir = resolve(base, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(4).toString('hex'));
  await mkdir(dir, { recursive: false });
  const state = { schema: SCHEMA, adapter, adapter_version: VERSION, cli_version: cliVersion, started_at: new Date().toISOString() };
  await writeFile(join(dir, 'run-state.json'), line(state), { flag: 'wx' });
  for (const name of FILES) await writeFile(join(dir, name), '', { flag: 'wx' });
  return { dir, state };
}
async function finalize(dir, state, stats, terminal) {
  const artifacts = {};
  for (const name of FILES) artifacts[name] = await info(join(dir, name));
  if (artifacts['events.jsonl'].sha256 !== stats.sha256) throw Error('EVENT_HASH_MISMATCH_DURING_FINALIZE');
  const m = {
    schema: SCHEMA, adapter: state.adapter, adapter_version: VERSION, cli_version: state.cli_version,
    started_at: state.started_at, ended_at: terminal.at, status: terminal.status,
    exit_code: terminal.exit_code, signal: terminal.signal,
    sealed_after_recorder_exit: terminal.sealed_after_recorder_exit,
    events: { count: stats.count, unknown_count: stats.unknown }, coverage: coverage(state.adapter), artifacts
  };
  const bytes = Buffer.from(JSON.stringify(m, null, 2) + '\n');
  const root = sha(bytes);
  await writeFile(join(dir, 'manifest.json'), bytes, { flag: 'wx' });
  await writeFile(join(dir, 'root.sha256'), root + '\n', { flag: 'wx' });
  await unlink(join(dir, 'run-state.json'));
  return { dir, root, manifest: m };
}
export async function ingest(input, base) {
  const { dir, state } = await init(base, 'generic-jsonl');
  const raw = createWriteStream(join(dir, 'stdout.bin'));
  const events = createWriteStream(join(dir, 'events.jsonl'));
  const builder = new EventBuilder(state.adapter, state.started_at, b => push(events, b));
  await builder.start();
  for await (const b of input) { await push(raw, b); await builder.feed(b); }
  await close(raw);
  const terminal = { phase: 'end', at: new Date().toISOString(), status: 'COMPLETE', exit_code: 0, signal: null, sealed_after_recorder_exit: false };
  const stats = await builder.finish(terminal); await close(events);
  return finalize(dir, state, stats, terminal);
}
async function codexExe() {
  if (process.platform !== 'win32') return 'codex';
  for (const folder of (process.env.PATH ?? '').split(delimiter)) {
    if (!folder) continue;
    const candidate = join(folder, 'codex.exe');
    try { if ((await stat(candidate)).isFile()) return candidate; } catch {}
  }
  const base = join(homedir(), '.vscode', 'extensions');
  const names = (await readdir(base).catch(() => [])).filter(n => /^openai\.chatgpt-.*-win32-x64$/.test(n)).sort().reverse();
  for (const n of names) {
    const p = join(base, n, 'bin', 'windows-x86_64', 'codex.exe');
    try { if ((await stat(p)).isFile()) return p; } catch {}
  }
  throw Error('CODEX_DIRECT_EXECUTABLE_NOT_FOUND');
}
export async function executableFor(adapter, override) {
  if (override) {
    if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(override)) throw Error('SHELL_SHIM_NOT_ALLOWED');
    return override;
  }
  return adapter === 'codex' ? codexExe() : process.platform === 'win32' ? 'claude.exe' : 'claude';
}
async function versionOf(exe) {
  return new Promise(done => {
    const child = spawn(exe, ['--version'], { shell: false, windowsHide: true });
    let out = '';
    child.stdout?.on('data', b => { if (out.length < 1000) out += b; });
    child.stderr?.on('data', b => { if (out.length < 1000) out += b; });
    child.once('error', () => done(null));
    child.once('close', () => done(out.trim().slice(0, 200) || null));
  });
}
export async function capture(adapter, prompt, base, cwd, override) {
  if (!['codex', 'claude'].includes(adapter)) throw Error('UNSUPPORTED_ADAPTER');
  const exe = await executableFor(adapter, override);
  const { dir, state } = await init(base, adapter, await versionOf(exe));
  const raw = createWriteStream(join(dir, 'stdout.bin'));
  const err = createWriteStream(join(dir, 'stderr.bin'));
  const events = createWriteStream(join(dir, 'events.jsonl'));
  const builder = new EventBuilder(adapter, state.started_at, b => push(events, b));
  await builder.start();
  const args = adapter === 'codex' ? ['exec', '--json', '-'] : ['--print', '--verbose', '--output-format', 'stream-json'];
  const child = spawn(exe, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let forwarded = null;
  const int = () => { forwarded = 'SIGINT'; child.kill('SIGINT'); };
  const term = () => { forwarded = 'SIGTERM'; child.kill('SIGTERM'); };
  process.on('SIGINT', int); process.on('SIGTERM', term);
  const exit = new Promise(done => { child.once('error', e => done({ code: null, signal: null, error: e.code })); child.once('close', (code, signal) => done({ code, signal, error: null })); });
  const outPump = (async () => { for await (const b of child.stdout) { await push(raw, b); await builder.feed(b); } await close(raw); })();
  const errPump = (async () => { for await (const b of child.stderr) await push(err, b); await close(err); })();
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  try {
    const [result] = await Promise.all([exit, outPump, errPump]);
    const terminal = {
      phase: 'end', at: new Date().toISOString(), status: result.code === 0 && !forwarded ? 'COMPLETE' : 'PARTIAL',
      exit_code: result.code, signal: forwarded ?? result.signal ?? null, sealed_after_recorder_exit: false
    };
    const stats = await builder.finish(terminal); await close(events);
    return { ...await finalize(dir, state, stats, terminal), launch_error: result.error };
  } finally { process.off('SIGINT', int); process.off('SIGTERM', term); }
}
async function derive(rawPath, adapter, started, terminal) {
  const b = new EventBuilder(adapter, started, async () => {}); await b.start();
  for await (const chunk of createReadStream(rawPath)) await b.feed(chunk);
  return b.finish(terminal);
}
export async function verify(dir, expected = null) {
  if (expected !== null && !HEX.test(expected)) throw Error('INVALID_EXPECTED_ROOT');
  let bytes;
  try { bytes = await readFile(join(dir, 'manifest.json')); }
  catch {
    try {
      const state = JSON.parse(await readFile(join(dir, 'run-state.json'), 'utf8'));
      if (state.schema === SCHEMA && ADAPTERS.has(state.adapter)) return { verdict: 'UNSEALED_PARTIAL', root: null, errors: ['MANIFEST_MISSING'] };
    } catch {}
    return { verdict: 'INVALID', root: null, errors: ['MANIFEST_MISSING'] };
  }
  let m;
  try { m = JSON.parse(bytes.toString('utf8')); }
  catch { return { verdict: 'INVALID', root: null, errors: ['MANIFEST_INVALID_JSON'] }; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { verdict: 'INVALID', root: null, errors: ['MANIFEST_INVALID_SHAPE'] };
  const root = sha(bytes), errors = [];
  try { if ((await readFile(join(dir, 'root.sha256'), 'utf8')).trim() !== root) errors.push('LOCAL_ROOT_MISMATCH'); }
  catch { errors.push('ROOT_FILE_MISSING'); }
  if (expected !== null && expected !== root) errors.push('EXPECTED_ROOT_MISMATCH');
  if (m.schema !== SCHEMA || !ADAPTERS.has(m.adapter) || m.adapter_version !== VERSION) errors.push('MANIFEST_SCHEMA_INVALID');
  if (typeof m.started_at !== 'string' || !validTime(m.started_at) || !validTime(m.ended_at) || !['COMPLETE', 'PARTIAL'].includes(m.status)) errors.push('MANIFEST_STATUS_INVALID');
  if (m.status === 'COMPLETE' && (m.exit_code !== 0 || m.signal !== null || m.ended_at === null || m.sealed_after_recorder_exit)) errors.push('COMPLETE_CLAIM_INVALID');
  if (typeof m.sealed_after_recorder_exit !== 'boolean' || (m.sealed_after_recorder_exit && (m.status !== 'PARTIAL' || m.ended_at !== null))) errors.push('RECOVERY_CLAIM_INVALID');
  if (JSON.stringify(m.coverage) !== JSON.stringify(coverage(m.adapter))) errors.push('COVERAGE_INVALID');
  for (const name of FILES) {
    try { const actual = await info(join(dir, name)); if (actual.sha256 !== m.artifacts?.[name]?.sha256 || actual.bytes !== m.artifacts?.[name]?.bytes) errors.push('ARTIFACT_MISMATCH_' + name); }
    catch { errors.push('ARTIFACT_MISSING_' + name); }
  }
  if (!errors.some(e => e.startsWith('ARTIFACT_MISSING_')) && ADAPTERS.has(m.adapter) && validTime(m.started_at)) {
    const terminal = { phase: m.sealed_after_recorder_exit ? 'sealed_after_exit' : 'end', at: m.ended_at, status: m.status, exit_code: m.exit_code, signal: m.signal, sealed_after_recorder_exit: m.sealed_after_recorder_exit };
    const d = await derive(join(dir, 'stdout.bin'), m.adapter, m.started_at, terminal);
    if (d.sha256 !== m.artifacts?.['events.jsonl']?.sha256 || d.count !== m.events?.count || d.unknown !== m.events?.unknown_count) errors.push('EVENT_DERIVATION_MISMATCH');
  }
  return { verdict: errors.length ? 'INVALID' : expected ? 'UNCHANGED_RELATIVE_TO_EXPECTED_ROOT' : 'INTERNALLY_CONSISTENT_ONLY', root, errors, manifest: m };
}
export async function sealPartial(dir) {
  try { await stat(join(dir, 'manifest.json')); throw Error('RUN_ALREADY_SEALED'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let state;
  try { state = JSON.parse(await readFile(join(dir, 'run-state.json'), 'utf8')); }
  catch { throw Error('RECOVERY_STATE_MISSING'); }
  if (state.schema !== SCHEMA || !ADAPTERS.has(state.adapter) || typeof state.started_at !== 'string' || !validTime(state.started_at)) throw Error('RECOVERY_STATE_INVALID');
  for (const name of ['stdout.bin', 'stderr.bin']) { try { await stat(join(dir, name)); } catch { await writeFile(join(dir, name), ''); } }
  const handle = await open(join(dir, 'events.jsonl'), 'w');
  const builder = new EventBuilder(state.adapter, state.started_at, b => handle.write(b));
  const terminal = { phase: 'sealed_after_exit', at: null, status: 'PARTIAL', exit_code: null, signal: null, sealed_after_recorder_exit: true };
  try {
    await builder.start();
    for await (const b of createReadStream(join(dir, 'stdout.bin'))) await builder.feed(b);
    const stats = await builder.finish(terminal);
    await handle.close();
    return finalize(dir, state, stats, terminal);
  } catch (e) { await handle.close(); throw e; }
}
export async function summary(dir) {
  const v = await verify(dir);
  if (v.verdict === 'UNSEALED_PARTIAL') return { schema: SCHEMA, verification: 'UNSEALED_PARTIAL' };
  if (v.verdict !== 'INTERNALLY_CONSISTENT_ONLY') throw Error('SUMMARY_REQUIRES_VALID_RUN');
  const m = v.manifest;
  return {
    schema: SCHEMA, adapter: m.adapter, verification: v.verdict, status: m.status,
    started_at: validTime(m.started_at) ? m.started_at : null, ended_at: validTime(m.ended_at) ? m.ended_at : null,
    exit_code: Number.isInteger(m.exit_code) ? m.exit_code : null,
    event_count: Number.isSafeInteger(m.events.count) ? m.events.count : null,
    unknown_event_count: Number.isSafeInteger(m.events.unknown_count) ? m.events.unknown_count : null,
    raw_stdout_bytes: m.artifacts['stdout.bin'].bytes, raw_stderr_bytes: m.artifacts['stderr.bin'].bytes,
    root_sha256: v.root, coverage: coverage(m.adapter), sealed_after_recorder_exit: m.sealed_after_recorder_exit === true
  };
}
