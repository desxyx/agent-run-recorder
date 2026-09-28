#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stdin, stdout, stderr, exitCode } from 'node:process';
import { capture, ingest, verify, sealPartial, summary } from '../lib/recorder.js';

const usage = `agent-recorder v0.1
  ingest generic-jsonl [--input FILE] [--out DIRECTORY]
  capture codex|claude [--prompt-file FILE] [--out DIRECTORY] [--cwd DIRECTORY] [--exe EXECUTABLE]
  verify RUN [--expected-root SHA256]
  seal-partial RUN
  summary RUN

Prompts default to stdin. Captured raw streams are private local data.
Keep the printed root receipt outside the run directory to check against later changes.`;
function parse(args, allowed) {
  const opts = {}; let positional = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    const key = args[i].slice(2);
    if (!allowed.includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || key in opts) throw Error('INVALID_OPTIONS');
    opts[key] = args[++i];
  }
  return { opts, positional };
}
async function readPrompt(path) {
  if (path) return readFile(path);
  const chunks = [];
  for await (const b of stdin) chunks.push(b);
  return Buffer.concat(chunks);
}
function receipt(result) {
  stdout.write(JSON.stringify({ run: result.dir, status: result.manifest.status, root_sha256: result.root, receipt: 'ROOT_SHA256=' + result.root, exit_code: result.manifest.exit_code, launch_error: result.launch_error ?? null }) + '\n');
  stdout.write('ROOT_SHA256=' + result.root + '\n');
}
async function main(args) {
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) { stdout.write(usage + '\n'); return; }
  const command = args.shift();
  if (command === 'ingest') {
    const { opts, positional } = parse(args, ['input', 'out']);
    if (positional.length !== 1 || positional[0] !== 'generic-jsonl') throw Error('INVALID_INGEST_SYNTAX');
    const base = resolve(opts.out ?? 'runs'); await mkdir(base, { recursive: true });
    receipt(await ingest(opts.input ? createReadStream(resolve(opts.input)) : stdin, base));
    return;
  }
  if (command === 'capture') {
    const { opts, positional } = parse(args, ['prompt-file', 'out', 'cwd', 'exe']);
    if (positional.length !== 1 || !['codex', 'claude'].includes(positional[0])) throw Error('INVALID_CAPTURE_SYNTAX');
    const base = resolve(opts.out ?? 'runs'); await mkdir(base, { recursive: true });
    const result = await capture(positional[0], await readPrompt(opts['prompt-file']), base, resolve(opts.cwd ?? '.'), opts.exe);
    receipt(result);
    if (result.manifest.status !== 'COMPLETE') process.exitCode = 2;
    return;
  }
  if (command === 'verify') {
    const { opts, positional } = parse(args, ['expected-root']);
    if (positional.length !== 1) throw Error('INVALID_VERIFY_SYNTAX');
    const result = await verify(resolve(positional[0]), opts['expected-root'] ?? null);
    stdout.write(JSON.stringify({ verdict: result.verdict, root_sha256: result.root, errors: result.errors }) + '\n');
    if (result.verdict === 'INVALID') process.exitCode = 2;
    return;
  }
  if (command === 'seal-partial') {
    const { opts, positional } = parse(args, []);
    if (positional.length !== 1 || Object.keys(opts).length) throw Error('INVALID_SEAL_SYNTAX');
    receipt(await sealPartial(resolve(positional[0])));
    return;
  }
  if (command === 'summary') {
    const { opts, positional } = parse(args, []);
    if (positional.length !== 1 || Object.keys(opts).length) throw Error('INVALID_SUMMARY_SYNTAX');
    stdout.write(JSON.stringify(await summary(resolve(positional[0]))) + '\n');
    return;
  }
  throw Error('UNKNOWN_COMMAND');
}
main(process.argv.slice(2)).catch(e => {
  // Error text can contain raw source data or paths. The CLI prints only a stable code.
  const code = /^([A-Z][A-Z0-9_]+)$/.test(e.message) ? e.message : 'OPERATION_FAILED';
  stderr.write(code + '\n');
  process.exitCode = 1;
});
