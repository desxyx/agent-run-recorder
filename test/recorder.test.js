import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ingest, capture, verify, sealPartial, summary, SCHEMA } from '../lib/recorder.js';

const hash = b => createHash('sha256').update(b).digest('hex');
const input = (...items) => Readable.from([items.map(x => JSON.stringify(x)).join('\n') + '\n']);
async function base() { return mkdtemp(join(tmpdir(), 'agent-recorder-test-')); }
async function rewriteManifest(dir, change) {
  const path = join(dir, 'manifest.json');
  const m = JSON.parse(await readFile(path, 'utf8'));
  await change(m);
  const bytes = Buffer.from(JSON.stringify(m, null, 2) + '\n');
  await writeFile(path, bytes);
  await writeFile(join(dir, 'root.sha256'), hash(bytes) + '\n');
}
async function fileDigest(dir, name) {
  const b = await readFile(join(dir, name));
  return { sha256: hash(b), bytes: b.length };
}
test('generic run, anchored verify, and source kind mapping', async () => {
  const run = await ingest(input({ type: 'session', id: 's' }, { type: 'assistant_output', text: 'hello' }, { type: 'tool_call', name: 'x' }, { type: 'tool_result', value: 1 }, { type: 'error', message: 'x' }, { type: 'not_mapped' }), await base());
  assert.equal((await verify(run.dir)).verdict, 'INTERNALLY_CONSISTENT_ONLY');
  assert.equal((await verify(run.dir, run.root)).verdict, 'UNCHANGED_RELATIVE_TO_EXPECTED_ROOT');
  const events = (await readFile(join(run.dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(x => x.kind), ['session', 'session', 'assistant_output', 'tool_call', 'tool_result', 'error', 'unknown', 'session']);
  assert.equal((await summary(run.dir)).unknown_event_count, 1);
});
test('raw, event order, and metadata tampering fail verification', async () => {
  const run = await ingest(input({ type: 'session' }, { type: 'assistant_output' }), await base());
  const root = run.root;
  await writeFile(join(run.dir, 'stdout.bin'), 'tampered\n');
  assert.equal((await verify(run.dir, root)).verdict, 'INVALID');
  const second = await ingest(input({ type: 'session' }, { type: 'assistant_output' }), await base());
  const eventPath = join(second.dir, 'events.jsonl');
  const lines = (await readFile(eventPath, 'utf8')).trimEnd().split('\n');
  [lines[1], lines[2]] = [lines[2], lines[1]];
  await writeFile(eventPath, lines.join('\n') + '\n');
  await rewriteManifest(second.dir, async m => { m.artifacts['events.jsonl'] = await fileDigest(second.dir, 'events.jsonl'); });
  assert.ok((await verify(second.dir)).errors.includes('EVENT_DERIVATION_MISMATCH'));
  const third = await ingest(input({ type: 'session' }), await base());
  await rewriteManifest(third.dir, async m => { m.cli_version = 'altered'; });
  assert.equal((await verify(third.dir, third.root)).verdict, 'INVALID');
  assert.equal((await verify(third.dir)).verdict, 'INTERNALLY_CONSISTENT_ONLY');
});
test('coordinated rewrite passes only unanchored consistency', async () => {
  const original = await ingest(input({ type: 'assistant_output', text: 'before' }), await base());
  const replacement = await ingest(input({ type: 'assistant_output', text: 'after' }), await base());
  for (const name of ['stdout.bin', 'stderr.bin', 'events.jsonl', 'manifest.json', 'root.sha256']) await copyFile(join(replacement.dir, name), join(original.dir, name));
  assert.equal((await verify(original.dir)).verdict, 'INTERNALLY_CONSISTENT_ONLY');
  const anchored = await verify(original.dir, original.root);
  assert.equal(anchored.verdict, 'INVALID');
  assert.ok(anchored.errors.includes('EXPECTED_ROOT_MISMATCH'));
});
test('crash recovery seals only surviving bytes as PARTIAL', async () => {
  const dir = join(await base(), 'unsealed');
  await mkdir(dir);
  const state = { schema: SCHEMA, adapter: 'generic-jsonl', adapter_version: '0.1.0', cli_version: null, started_at: new Date().toISOString() };
  await writeFile(join(dir, 'run-state.json'), JSON.stringify(state) + '\n');
  await writeFile(join(dir, 'stdout.bin'), '{"type":"session"}\n{"type":"partial"');
  await writeFile(join(dir, 'stderr.bin'), '');
  assert.equal((await verify(dir)).verdict, 'UNSEALED_PARTIAL');
  const sealed = await sealPartial(dir);
  assert.equal(sealed.manifest.status, 'PARTIAL');
  assert.equal(sealed.manifest.ended_at, null);
  assert.equal(sealed.manifest.sealed_after_recorder_exit, true);
  assert.equal((await verify(dir, sealed.root)).verdict, 'UNCHANGED_RELATIVE_TO_EXPECTED_ROOT');
});
test('child interruption while recorder lives finalizes a PARTIAL run', async () => {
  const work = await base();
  await writeFile(join(work, 'exec'), 'setInterval(() => {}, 1000);\n');
  const out = await base();
  const task = capture('codex', Buffer.from('synthetic'), out, work, process.execPath);
  setTimeout(() => process.emit('SIGINT'), 250);
  const run = await task;
  assert.equal(run.manifest.status, 'PARTIAL');
  assert.equal(run.manifest.signal, 'SIGINT');
  assert.equal((await verify(run.dir, run.root)).verdict, 'UNCHANGED_RELATIVE_TO_EXPECTED_ROOT');
});
test('terminated recorder leaves UNSEALED_PARTIAL and can be sealed later', async () => {
  const out = await base();
  const cli = fileURLToPath(new URL('../bin/agent-recorder.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'ingest', 'generic-jsonl', '--out', out], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.write('{"type":"session"}\n');
  let dirs = [];
  for (let n = 0; n < 40; n++) {
    dirs = await readdir(out);
    if (dirs.length) break;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.equal(dirs.length, 1);
  await new Promise(r => setTimeout(r, 100));
  child.kill();
  await once(child, 'close');
  const dir = join(out, dirs[0]);
  assert.equal((await verify(dir)).verdict, 'UNSEALED_PARTIAL');
  const sealed = await sealPartial(dir);
  assert.equal(sealed.manifest.status, 'PARTIAL');
  assert.equal((await verify(dir, sealed.root)).verdict, 'UNCHANGED_RELATIVE_TO_EXPECTED_ROOT');
});
test('summary full bytes exclude source secrets, and leaking control fails the scanner', async () => {
  const secrets = {
    prompt: 'PROMPT_SECRET_712', args: 'ARGS_SECRET_345', path: 'PATH_SECRET_680',
    error: 'ERROR_SECRET_901', stderr: 'STDERR_SECRET_222', unknown: 'UNKNOWN_SECRET_357',
    version: 'VERSION_SECRET_468', label: 'LABEL_SECRET_579'
  };
  const run = await ingest(input(
    { type: 'tool_call', prompt: secrets.prompt, arguments: secrets.args, path: secrets.path, label: secrets.label },
    { type: 'error', message: secrets.error },
    { type: secrets.unknown, text: 'hidden' }
  ), await base());
  await writeFile(join(run.dir, 'stderr.bin'), secrets.stderr);
  await rewriteManifest(run.dir, async m => {
    m.cli_version = secrets.version;
    m.artifacts['stderr.bin'] = await fileDigest(run.dir, 'stderr.bin');
  });
  const cli = fileURLToPath(new URL('../bin/agent-recorder.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'summary', run.dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', b => chunks.push(b));
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const output = Buffer.concat(chunks);
  const leaks = bytes => Object.values(secrets).filter(s => bytes.includes(Buffer.from(s)));
  assert.deepEqual(leaks(output), []);
  assert.match(output.toString(), /"unknown_event_count":1/);
  const deliberatelyLeaking = Buffer.concat([output, Buffer.from(secrets.prompt)]);
  assert.deepEqual(leaks(deliberatelyLeaking), [secrets.prompt]);
});
