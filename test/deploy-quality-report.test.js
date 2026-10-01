import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, readlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQualityReport } from '../ops/calib-telemetry/quality-report.mjs';
import { checkQualityReport } from '../ops/calib-telemetry/quality-report-check.mjs';
import { shellQuote, parseOptions } from '../scripts/deploy-quality-report.mjs';

const deployScript = fileURLToPath(new URL('../scripts/deploy-quality-report.mjs', import.meta.url));
const since = '2026-09-16T11:20:32Z';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const record = extra => ({ board: 'BDM-030', receivedAt: '2026-09-20T12:00:00Z', before: { off: [2, 0.555], noise: [0.2, 0.3] }, after: { off: [0.555, 0.555], noise: [0.2, 0.3] }, ...extra });
const inputText = [record(), record({ receivedAt: '2026-09-10T12:00:00Z' }), record({ receivedAt: '2026-09-16T12:00:00Z' }), record({ fw: 1234 }), '{broken', null, record({ after: null })]
  .map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n\n';

async function snapshot(directory) {
  const result = {};
  async function visit(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const file = path.join(dir, name), relative = path.relative(directory, file), stat = await lstat(file);
      if (stat.isSymbolicLink()) result[relative] = { link: await readlink(file) };
      else if (stat.isDirectory()) { result[relative] = { directory: true, mode: stat.mode & 0o777 }; await visit(file); }
      else result[relative] = { hash: digest(await readFile(file)), mode: stat.mode & 0o777 };
    }
  }
  await visit(directory);
  return result;
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sense-quality-deploy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = path.join(directory, "remote with space's");
  const root = path.join(remote, 'ops'), data = path.join(remote, 'data'), bin = path.join(directory, 'bin');
  await mkdir(root, { recursive: true }); await mkdir(path.join(data, 'private'), { recursive: true }); await mkdir(bin);
  await writeFile(path.join(data, 'sessions.jsonl'), inputText, { mode: 0o600 });
  await writeFile(path.join(data, 'events-v2.jsonl'), '{"untouched":"events"}\n', { mode: 0o600 });
  await writeFile(path.join(root, 'quality-report.mjs'), 'export const REPORT_VERSION = 1;\n');
  await writeFile(path.join(root, 'quality-report-cli.mjs'), '// old CLI remains available for rollback\n');
  const oldReport = JSON.stringify({ schema: 'sense-calibrator.telemetry-quality.v1', reportVersion: 1, input: { bytes: Buffer.byteLength(inputText) } }) + '\n';
  const latest = path.join(data, 'private/quality-latest.json'), history = path.join(data, 'private/quality-history.log');
  await writeFile(latest, oldReport, { mode: 0o600 });
  await writeFile(history, 'old v1 summary\n', { mode: 0o600 });
  const otherCron = '# unrelated jobs must survive\n5 3 * * * /home/martino/backup.sh\n';
  const qualityCron = `10 4 * * * umask 077 && /usr/bin/node ${shellQuote(path.join(root, 'quality-report-cli.mjs'))} --input ${shellQuote(path.join(data, 'sessions.jsonl'))} --output ${shellQuote(latest)} --since ${since} --summary >> ${shellQuote(history)} 2>&1`;
  const cronFile = path.join(remote, 'crontab.txt'), trace = path.join(directory, 'trace.txt');
  await writeFile(cronFile, `${otherCron}${qualityCron}\n`);
  const executable = async (name, source) => writeFile(path.join(bin, name), `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  await executable('ssh', `
    const fs = require('node:fs'), { spawnSync } = require('node:child_process');
    fs.appendFileSync(process.env.TEST_TRACE, 'ssh ' + process.argv.slice(2).join(' ') + '\\n');
    let program = fs.readFileSync(0, 'utf8');
    const fault = process.env.TEST_FAULT;
    if (process.env.TEST_NEW_RELEASE === '1' || fault === 'import') {
      const change = fault === 'import' ? "config.bundle.files['quality-report-cli.mjs'] += ' invalid syntax !!!';" : "config.bundle.files['quality-report-cli.mjs'] += '// second reviewed release';";
      program = program.replace('const root = config.remoteDir, dataDir = config.dataDir;', change + "config.bundle.manifest.hashes['quality-report-cli.mjs'] = hash(config.bundle.files['quality-report-cli.mjs']); const { release, ...identity } = config.bundle.manifest; config.bundle.manifest.release = hash(JSON.stringify(identity)); const root = config.remoteDir, dataDir = config.dataDir;");
    }
    if (fault === 'staging-write') program = program.replace('await fs.writeFile(path.join(staging, name), source,', "throw new Error('forced staging write failure'); await fs.writeFile(path.join(staging, name), source,");
    if (fault?.startsWith('hash:')) program = program.replace("const fs = await import('node:fs/promises');", "config.bundle.files[" + JSON.stringify(fault.slice(5)) + "] += 'tampered'; const fs = await import('node:fs/promises');");
    if (fault === 'current-report') program = program.replace('await checkHashes(await fs.realpath(current));', "throw new Error('forced verification after current report write'); await checkHashes(await fs.realpath(current));");
    if (fault === 'bad-version') program = program.replace('await checkHashes(staging);', "await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ ...config.bundle.manifest, reportVersion: 1 })); await checkHashes(staging);");
    if (fault === 'candidate-version' || fault === 'candidate-counts') program = program.replace('stagedCheck.checkQualityReport(report, snapshot,', (fault === 'candidate-version' ? 'report.reportVersion = 1; ' : 'report.input.bytes++; ') + 'stagedCheck.checkQualityReport(report, snapshot,');
    const command = process.argv.at(-1).replaceAll('/usr/bin/node', JSON.stringify(process.execPath)).replaceAll('/usr/bin/flock', JSON.stringify(process.env.TEST_BIN + '/flock'));
    const result = spawnSync('/bin/sh', ['-c', command], { input: program, encoding: 'utf8', env: process.env });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
  `);
  await executable('flock', `
    const fs = require('node:fs'), { spawnSync } = require('node:child_process');
    fs.appendFileSync(process.env.TEST_TRACE, 'flock\\n');
    if (process.env.TEST_FAULT === 'lock-busy') process.exit(75);
    const args = process.argv.slice(2); args.shift(); if (args[0] === '-E') args.splice(0, 2);
    const lock = args.shift(); fs.closeSync(fs.openSync(lock, 'a', 0o600));
    const result = spawnSync(args.shift(), args, { input: fs.readFileSync(0), encoding: 'utf8', env: process.env });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
  `);
  await executable('crontab', `
    const fs = require('node:fs'); fs.appendFileSync(process.env.TEST_TRACE, 'crontab ' + process.argv[2] + '\\n');
    if (process.argv[2] === '-l') {
      const counter = process.env.TEST_TRACE + '.reads'; const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0) + 1; fs.writeFileSync(counter, String(n));
      if (process.env.TEST_FAULT === 'cron-changed' && n === 2) fs.appendFileSync(process.env.TEST_CRON, '# concurrent edit\\n');
      process.stdout.write(fs.readFileSync(process.env.TEST_CRON, 'utf8'));
    } else {
      const counter = process.env.TEST_TRACE + '.writes'; const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0) + 1; fs.writeFileSync(counter, String(n));
      if (process.env.TEST_FAIL_ROLLBACK === '1' && n === 2) { process.stderr.write('forced cron restore failure'); process.exit(1); }
      fs.writeFileSync(process.env.TEST_CRON, fs.readFileSync(0));
      if (process.env.TEST_FAULT === 'history-write' && n === 1) fs.mkdirSync(process.env.TEST_DATA + '/private/quality-history-v2.log');
    }
  `);
  await executable('ps', `process.stdout.write(process.env.TEST_FAULT === 'legacy-running' ? 'node ' + process.env.TEST_ROOT + '/quality-report-cli.mjs\\n' : 'unrelated service\\n');`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_BIN: bin, TEST_TRACE: trace, TEST_CRON: cronFile, TEST_DATA: data, TEST_ROOT: root };
  const run = (args = [], extra = {}) => spawnSync(process.execPath, [deployScript, '--host', 'test.invalid', '--remote-dir', root, '--data-dir', data, ...args], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 15000 });
  return { remote, root, data, latest, history, cronFile, oldReport, otherCron, qualityCron, trace, run, env };
}

test('verification reconciles exclusions, malformed records and unmeasured sessions against the input snapshot', () => {
  const report = buildQualityReport(inputText, { sinceInclusive: since });
  const checked = checkQualityReport(report, inputText, { since });
  assert.equal(checked.inputRows, 7); assert.equal(checked.sessions, 2); assert.equal(checked.validMeasurements, 1);
  for (const mutation of [r => r.reportVersion = 1, r => r.input.bytes++, r => r.input.nonEmptyLines++, r => r.sessions.total++, r => r.outcomes.denominator++, r => r.window.sinceInclusive = null]) {
    const changed = structuredClone(report); mutation(changed);
    assert.throws(() => checkQualityReport(changed, inputText, { since }), /verification/);
  }
});

test('dry-run reads metadata/cron, detects v1 and absent lattice, and changes no remote file', async t => {
  const f = await fixture(t), before = await snapshot(f.remote);
  const result = f.run(['--dry-run']); assert.equal(result.status, 0, result.stderr);
  const preview = JSON.parse(result.stdout); assert.equal(preview.reportVersion, 1); assert.equal(preview.proposedVersion, 2);
  assert.equal(preview.installedHashes['lattice.mjs'], null); assert.equal(preview.moduleHashesMatch['quality-report.mjs'], false);
  assert.deepEqual(await snapshot(f.remote), before);
  const trace = await readFile(f.trace, 'utf8'); assert.ok(!trace.includes('flock')); assert.ok(!trace.includes('crontab -\n'));
});

test('deploy produces verified v2, separates its history and preserves all source logs and other jobs; repeated deploy reuses the release', async t => {
  const f = await fixture(t), inputHash = digest(await readFile(path.join(f.data, 'sessions.jsonl'))), events = await readFile(path.join(f.data, 'events-v2.jsonl'), 'utf8');
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  const deployed = JSON.parse(result.stdout), report = JSON.parse(await readFile(f.latest, 'utf8'));
  assert.equal(deployed.deployed, true); assert.equal(report.schema, 'sense-calibrator.telemetry-quality.v2'); assert.equal(report.reportVersion, 2);
  assert.equal(report.input.nonEmptyLines, 7); assert.deepEqual(report.sessions, { total: 2, validMeasurements: 1, invalidMeasurements: 1 });
  assert.equal(digest(await readFile(path.join(f.data, 'sessions.jsonl'))), inputHash); assert.equal(await readFile(path.join(f.data, 'events-v2.jsonl'), 'utf8'), events);
  assert.equal(await readFile(f.history, 'utf8'), 'old v1 summary\n');
  assert.equal(await readFile(path.join(deployed.backup, 'quality-latest-before.json'), 'utf8'), f.oldReport);
  const cron = await readFile(f.cronFile, 'utf8'); assert.ok(cron.startsWith(f.otherCron)); assert.ok(cron.includes('quality-history-v2.log')); assert.ok(cron.includes('flock -n'));
  assert.match(await readFile(path.join(f.data, 'private/quality-history-v2.log'), 'utf8'), /schema=sense-calibrator.telemetry-quality.v2; reportVersion=2;/);
  assert.equal((await lstat(f.latest)).mode & 0o777, 0o600);
  const again = f.run(); assert.equal(again.status, 0, again.stderr); assert.equal(JSON.parse(again.stdout).release, deployed.release);
  assert.equal((await readdir(path.join(f.root, 'releases'))).length, 1); assert.equal(await readFile(f.history, 'utf8'), 'old v1 summary\n');
  const cronRun = spawnSync(process.execPath, [path.join(f.root, 'current/quality-report-runner.mjs'), '--input', path.join(f.data, 'sessions.jsonl'), '--output', f.latest, '--since', since, '--summary'], {
    encoding: 'utf8', env: { ...f.env, CALIB_REPORT_EXCLUDE_BEFORE: 'none', CALIB_REPORT_PUBLIC_THRESHOLD_PCT: '99' },
  });
  assert.equal(cronRun.status, 0, cronRun.stderr); assert.match(cronRun.stdout, /reportVersion=2/);
  const nightly = JSON.parse(await readFile(f.latest, 'utf8')); assert.equal(nightly.input.excludedBeforeGuard, 1); assert.equal(nightly.definitions.publicThresholdPct, 1.2);
});

test('staging failures and concurrent cron changes never activate or overwrite the existing report', async t => {
  for (const fault of ['staging-write', 'hash:quality-report.mjs', 'hash:quality-report-cli.mjs', 'hash:lattice.mjs', 'bad-version', 'import', 'candidate-version', 'candidate-counts', 'cron-changed']) {
    await t.test(fault, async sub => {
      const f = await fixture(sub), initialCron = await readFile(f.cronFile, 'utf8');
      const result = f.run([], { TEST_FAULT: fault }); assert.notEqual(result.status, 0); assert.ok(!result.stdout.includes('"deployed": true'));
      assert.match(result.stderr, /forced staging write failure|release hash mismatch|release manifest mismatch|crontab changed during staging|Unexpected identifier|quality report verification/);
      assert.equal(await readFile(f.latest, 'utf8'), f.oldReport); await assert.rejects(readlink(path.join(f.root, 'current')), { code: 'ENOENT' });
      assert.equal(await readFile(f.history, 'utf8'), 'old v1 summary\n');
      assert.equal(await readFile(f.cronFile, 'utf8'), initialCron + (fault === 'cron-changed' ? '# concurrent edit\n' : ''));
    });
  }
});

test('rollback from an existing v2 release restores its pointer and exact report after a different release fails', async t => {
  const f = await fixture(t), first = f.run(); assert.equal(first.status, 0, first.stderr);
  const oldPointer = await readlink(path.join(f.root, 'current')), oldReport = await readFile(f.latest, 'utf8'), cron = await readFile(f.cronFile, 'utf8');
  const failed = f.run([], { TEST_FAULT: 'current-report', TEST_NEW_RELEASE: '1' }); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /restored/);
  assert.equal(await readlink(path.join(f.root, 'current')), oldPointer); assert.equal(await readFile(f.latest, 'utf8'), oldReport); assert.equal(await readFile(f.cronFile, 'utf8'), cron);
  assert.equal((await readdir(path.join(f.root, 'releases'))).length, 2);
});

test('dry-run on a missing target fails without creating it or a lock', async t => {
  const f = await fixture(t), before = await snapshot(f.remote);
  const result = f.run(['--dry-run', '--remote-dir', path.join(f.root, 'missing')]); assert.notEqual(result.status, 0); assert.match(result.stderr, /ENOENT/);
  assert.deepEqual(await snapshot(f.remote), before);
});

test('failures after activation restore report bytes, pointer and only the quality cron line', async t => {
  for (const fault of ['current-report', 'history-write', 'legacy-running']) {
    await t.test(fault, async sub => {
      const f = await fixture(sub), initialCron = await readFile(f.cronFile, 'utf8');
      const result = f.run([], { TEST_FAULT: fault }); assert.notEqual(result.status, 0); assert.match(result.stderr, /restored/);
      assert.equal(await readFile(f.latest, 'utf8'), f.oldReport); assert.equal(await readFile(f.cronFile, 'utf8'), initialCron);
      await assert.rejects(readlink(path.join(f.root, 'current')), { code: 'ENOENT' }); assert.equal(await readFile(f.history, 'utf8'), 'old v1 summary\n');
    });
  }
});

test('rollback failure is explicit and never reported as deployment success', async t => {
  const f = await fixture(t), result = f.run([], { TEST_FAULT: 'current-report', TEST_FAIL_ROLLBACK: '1' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /ROLLBACK FAILED/); assert.match(result.stderr, /backup=/); assert.ok(!result.stdout.includes('"deployed": true'));
  assert.equal(await readFile(f.latest, 'utf8'), f.oldReport); assert.ok((await readFile(f.cronFile, 'utf8')).startsWith(f.otherCron));
});

test('a busy shared lock and invalid cron/path abort without changing report or logs', async t => {
  const f = await fixture(t), before = await snapshot(f.remote);
  const locked = f.run([], { TEST_FAULT: 'lock-busy' }); assert.notEqual(locked.status, 0); assert.match(locked.stderr, /lock is busy/); assert.deepEqual(await snapshot(f.remote), before);
  await writeFile(f.cronFile, (await readFile(f.cronFile, 'utf8')).replace('--summary', '--summary --exclude-before none'));
  const incompatible = await snapshot(f.remote), invalid = f.run(['--dry-run']); assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /cron entry differs/); assert.deepEqual(await snapshot(f.remote), incompatible);
  assert.throws(() => parseOptions(['--data-dir', '/tmp/data%bad']), /control characters/);
});
