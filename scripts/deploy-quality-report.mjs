#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildQualityReport } from '../ops/calib-telemetry/quality-report.mjs';
import { checkQualityReport } from '../ops/calib-telemetry/quality-report-check.mjs';

const DEFAULTS = {
  host: 'martino@91.99.217.255',
  remoteDir: '/home/martino/sense-calibrator-ops',
  dataDir: '/var/lib/calib-telemetry',
  since: '2026-09-16T11:20:32Z',
};
const sha = text => createHash('sha256').update(text).digest('hex');

export function shellQuote(value) {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function parseOptions(argv) {
  const options = { ...DEFAULTS, dryRun: false };
  const flags = { '--host': 'host', '--remote-dir': 'remoteDir', '--data-dir': 'dataDir', '--since': 'since' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else if (flags[flag] && argv[i + 1] && !argv[i + 1].startsWith('--')) options[flags[flag]] = argv[++i];
    else throw new Error(`unknown or incomplete option: ${flag}`);
  }
  for (const field of ['remoteDir', 'dataDir']) {
    options[field] = options[field].replace(/\/+$/, '');
    if (!options[field].startsWith('/') || /[%\r\n\0]/.test(options[field]) || options[field] === '/') {
      throw new Error(`${field} must be an absolute path without cron control characters`);
    }
  }
  if (options.remoteDir === options.dataDir || options.remoteDir.startsWith(`${options.dataDir}/`)) {
    throw new Error('report code must live outside the telemetry data directory');
  }
  if (!/^[A-Za-z0-9_.@:-]+$/.test(options.host) || options.host.startsWith('-')) throw new Error('invalid SSH host');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(options.since)
      || !Number.isFinite(Date.parse(options.since))) throw new Error('invalid --since');
  return options;
}

export async function buildRelease(options) {
  const sources = {
    'quality-report.mjs': '../ops/calib-telemetry/quality-report.mjs',
    'quality-report-cli.mjs': '../ops/calib-telemetry/quality-report-cli.mjs',
    'lattice.mjs': '../js/calib/lattice.js',
    'quality-report-check.mjs': '../ops/calib-telemetry/quality-report-check.mjs',
    'quality-report-runner.mjs': '../ops/calib-telemetry/quality-report-runner.mjs',
  };
  const files = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([name, source]) =>
    [name, await readFile(new URL(source, import.meta.url), 'utf8')])));
  const report = buildQualityReport('', { sinceInclusive: options.since });
  checkQualityReport(report, '', { since: options.since });
  const hashes = Object.fromEntries(Object.entries(files).map(([name, source]) => [name, sha(source)]));
  const manifest = {
    schema: report.schema, reportVersion: report.reportVersion,
    since: options.since, definitions: report.definitions, exclusions: report.exclusions, hashes,
  };
  manifest.release = sha(JSON.stringify(manifest));
  return { files, manifest };
}

// Questo programma viaggia su stdin SSH: dry-run usa soltanto letture.
// Le dipendenze sono built-in Node; niente installazioni né accesso a PM2/nginx.
export async function remoteMain(config) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { createHash, randomBytes } = await import('node:crypto');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { pathToFileURL } = await import('node:url');
  const exec = promisify(execFile);
  const hash = data => createHash('sha256').update(data).digest('hex');
  const quote = value => /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
  const root = config.remoteDir, dataDir = config.dataDir;
  const canonicalRoot = await fs.realpath(root);
  const input = path.join(dataDir, 'sessions.jsonl');
  const privateDir = path.join(dataDir, 'private');
  const latest = path.join(privateDir, 'quality-latest.json');
  const history = path.join(privateDir, 'quality-history-v2.log');
  const current = path.join(root, 'current');
  const lock = path.join(root, '.quality-report.lock');
  const oldCron = `10 4 * * * umask 077 && /usr/bin/node ${quote(path.join(root, 'quality-report-cli.mjs'))} --input ${quote(input)} --output ${quote(latest)} --since ${quote(config.since)} --summary >> ${quote(path.join(privateDir, 'quality-history.log'))} 2>&1`;
  const newCron = `10 4 * * * umask 077 && /usr/bin/flock -n ${quote(lock)} /usr/bin/node ${quote(path.join(current, 'quality-report-runner.mjs'))} --input ${quote(input)} --output ${quote(latest)} --since ${quote(config.since)} --summary >> ${quote(history)} 2>&1`;
  const readCron = async () => (await exec('crontab', ['-l'])).stdout;
  const installCron = async text => {
    await new Promise((resolve, reject) => {
      const child = execFile('crontab', ['-'], error => error ? reject(error) : resolve());
      child.stdin.end(text);
    });
  };
  const ownLine = text => {
    const lines = text.split('\n').filter(line => !line.trimStart().startsWith('#')
      && (line.includes(quote(path.join(root, 'quality-report-cli.mjs'))) || line.includes(quote(path.join(current, 'quality-report-runner.mjs')))));
    if (lines.length !== 1 || ![oldCron, newCron].includes(lines[0])) throw new Error('quality cron entry differs or is duplicated; refusing to replace it');
    return lines[0];
  };
  const maybeRead = async file => { try { return await fs.readFile(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const regular = async (file, optional = false) => {
    try { if (!(await fs.lstat(file)).isFile()) throw new Error(`${file} must be a regular file, not a symlink`); }
    catch (e) { if (!optional || e.code !== 'ENOENT') throw e; }
  };
  const pointer = async () => {
    try {
      const stat = await fs.lstat(current);
      if (!stat.isSymbolicLink()) throw new Error('current must be a symlink');
      const target = await fs.readlink(current);
      const resolved = await fs.realpath(current);
      if (!resolved.startsWith(`${canonicalRoot}/releases/`)) throw new Error('current points outside report releases');
      return target;
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };
  const switchPointer = async target => {
    const temporary = path.join(root, `.current-${randomBytes(6).toString('hex')}`);
    try { await fs.symlink(target, temporary); await fs.rename(temporary, current); }
    finally { await fs.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  };
  const checkHashes = async directory => {
    for (const [name, expected] of Object.entries(config.bundle.manifest.hashes)) {
      await regular(path.join(directory, name));
      if (hash(await fs.readFile(path.join(directory, name))) !== expected) throw new Error(`release hash mismatch: ${name}`);
    }
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    if (JSON.stringify(manifest) !== JSON.stringify(config.bundle.manifest)) throw new Error('release manifest mismatch');
  };
  if (!(await fs.lstat(root)).isDirectory() || !(await fs.lstat(privateDir)).isDirectory()) throw new Error('report and private directories must already exist');
  await regular(input);
  await regular(latest, true);
  await regular(history, true);
  const initialCron = await readCron();
  const previousLine = ownLine(initialCron);
  const previousPointer = await pointer();
  const oldReport = await maybeRead(latest);
  const previousReport = oldReport ? JSON.parse(oldReport) : null;
  const initialInput = await fs.readFile(input);
  if (previousReport?.input?.bytes > initialInput.length) throw new Error('append-only input is smaller than the previous report snapshot');
  const installedHashes = {};
  for (const name of ['quality-report.mjs', 'quality-report-cli.mjs', 'lattice.mjs']) {
    const bytes = await maybeRead(path.join(previousPointer ? current : root, name));
    installedHashes[name] = bytes ? hash(bytes) : null;
  }
  const inspection = {
    current: previousPointer, schema: previousReport?.schema ?? null, reportVersion: previousReport?.reportVersion ?? null,
    inputBytes: initialInput.length, inputRows: initialInput.toString('utf8').split('\n').filter(line => line.trim()).length,
    inputSha256: hash(initialInput), installedHashes,
    moduleHashesMatch: Object.fromEntries(Object.entries(installedHashes).map(([name, actual]) => [name, actual === config.bundle.manifest.hashes[name]])),
    proposedSchema: config.bundle.manifest.schema, proposedVersion: config.bundle.manifest.reportVersion,
    release: config.bundle.manifest.release, cronChanges: previousLine !== newCron,
  };
  if (config.dryRun) { process.stdout.write(`${JSON.stringify({ dryRun: true, ...inspection }, null, 2)}\n`); return; }

  const id = `${new Date().toISOString().replaceAll(':', '-')}-${randomBytes(6).toString('hex')}`;
  const backup = path.join(root, 'deployments', id);
  const staging = path.join(root, `.stage-${id}`);
  const releaseDir = path.join(root, 'releases', config.bundle.manifest.release);
  let cronChanged = false, pointerChanged = false, reportChanged = false;
  await fs.mkdir(backup, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(backup, 'crontab-before.txt'), initialCron, { mode: 0o600, flag: 'wx' });
  await fs.writeFile(path.join(backup, 'state.json'), JSON.stringify({ previousPointer, previousLine, newCron, inspection }), { mode: 0o600, flag: 'wx' });
  if (oldReport) await fs.writeFile(path.join(backup, 'quality-latest-before.json'), oldReport, { mode: 0o600, flag: 'wx' });
  try {
    await fs.mkdir(staging, { mode: 0o700 });
    for (const [name, source] of Object.entries(config.bundle.files)) {
      await fs.writeFile(path.join(staging, name), source, { mode: 0o600, flag: 'wx' });
    }
    await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(config.bundle.manifest), { mode: 0o600, flag: 'wx' });
    await checkHashes(staging);
    const stagedRunner = await import(pathToFileURL(path.join(staging, 'quality-report-runner.mjs')).href);
    const stagedCheck = await import(pathToFileURL(path.join(staging, 'quality-report-check.mjs')).href);
    const args = output => ['--input', input, '--output', output, '--since', config.since, '--summary'];
    let candidate;
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await fs.readFile(input);
      const result = await stagedRunner.runVerifiedReport(args(path.join(backup, 'candidate.json')), { emit: false });
      const report = JSON.parse(await fs.readFile(path.join(backup, 'candidate.json'), 'utf8'));
      if (result.inputSha256 !== hash(snapshot)) continue;
      stagedCheck.checkQualityReport(report, snapshot, {
        since: config.since, definitions: config.bundle.manifest.definitions, exclusions: config.bundle.manifest.exclusions,
      });
      if (hash(await fs.readFile(input)) === hash(snapshot)) { candidate = result; break; }
    }
    if (!candidate) throw new Error('input changed during candidate verification; retry deployment');
    // Solo una release byte-identica può essere riutilizzata.
    await fs.mkdir(path.dirname(releaseDir), { recursive: true, mode: 0o700 });
    try { await fs.lstat(releaseDir); await checkHashes(releaseDir); }
    catch (e) { if (e.code !== 'ENOENT') throw e; await fs.rename(staging, releaseDir); }
    await checkHashes(releaseDir);
    if (await readCron() !== initialCron) throw new Error('crontab changed during staging; refusing activation');
    if (await pointer() !== previousPointer) throw new Error('current changed during staging; refusing activation');
    if (hash(await fs.readFile(input)) !== candidate.inputSha256) throw new Error('input changed before activation; retry deployment');

    // Il puntatore esiste prima che il cron nuovo lo utilizzi. Il cron condivide
    // flock col deploy; gli import risolvono una sola release immutabile.
    pointerChanged = true;
    await switchPointer(path.relative(root, releaseDir));
    if (previousLine !== newCron) {
      cronChanged = true;
      await installCron(initialCron.replace(previousLine, newCron));
      if (ownLine(await readCron()) !== newCron) throw new Error('cron activation verification failed');
    }
    // La prima migrazione parte da un cron privo di flock: rifiuta un vecchio
    // report ancora in esecuzione prima di cambiare il file corrente.
    if (previousLine === oldCron) {
      const processes = (await exec('ps', ['-eo', 'args='])).stdout;
      const legacyPath = path.join(root, 'quality-report-cli.mjs');
      if (processes.split('\n').some(line => line.includes(legacyPath) || line.includes(quote(legacyPath)))) {
        throw new Error('legacy quality job is still running; retry after it finishes');
      }
    }
    const activeRunner = await import(pathToFileURL(path.join(await fs.realpath(current), 'quality-report-runner.mjs')).href);
    reportChanged = true; // anche un errore successivo alla rinomina va ripristinato.
    const result = await activeRunner.runVerifiedReport(args(latest), { emit: false });
    const activeReport = JSON.parse(await fs.readFile(latest, 'utf8'));
    if (activeReport.schema !== config.bundle.manifest.schema || activeReport.reportVersion !== config.bundle.manifest.reportVersion
        || activeReport.input.bytes !== result.inputBytes || activeReport.input.nonEmptyLines !== result.inputRows) throw new Error('current report verification failed');
    await checkHashes(await fs.realpath(current));
    if (ownLine(await readCron()) !== newCron) throw new Error('quality cron changed after activation');
    await fs.appendFile(history, `${result.summary}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ deployed: true, ...result, release: config.bundle.manifest.release, backup }, null, 2)}\n`);
  } catch (error) {
    const rollbackErrors = [];
    const restore = async fn => { try { await fn(); } catch (e) { rollbackErrors.push(e.message); } };
    if (pointerChanged) await restore(async () => {
      if (previousPointer) await switchPointer(previousPointer);
      else await fs.unlink(current).catch(e => { if (e.code !== 'ENOENT') throw e; });
      if (await pointer() !== previousPointer) throw new Error('pointer rollback differs');
    });
    if (reportChanged) await restore(async () => {
      if (oldReport) {
        const temporary = path.join(privateDir, `.quality-rollback-${id}`);
        await fs.writeFile(temporary, oldReport, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, latest);
        if (hash(await fs.readFile(latest)) !== hash(oldReport)) throw new Error('report rollback hash differs');
      } else await fs.unlink(latest).catch(e => { if (e.code !== 'ENOENT') throw e; });
    });
    if (cronChanged) await restore(async () => {
      const now = await readCron();
      const line = ownLine(now);
      if (line === newCron) await installCron(now.replace(newCron, previousLine));
      if (ownLine(await readCron()) !== previousLine) throw new Error('cron rollback differs');
    });
    throw new Error(`${error.message}; ${rollbackErrors.length ? `ROLLBACK FAILED: ${rollbackErrors.join('; ')}` : 'previous report/pointer/cron restored'}; backup=${backup}`);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write('Usage: scripts/deploy-quality-report.sh [--dry-run] [--host HOST] [--remote-dir PATH] [--data-dir PATH] [--since RFC3339]\nDry-run only reads remote files/crontab. Deploy stages and verifies a v2 release, updates only the quality cron entry, and restores it on failure.\n');
    return;
  }
  const bundle = await buildRelease(options);
  const command = options.dryRun ? '/usr/bin/node --input-type=module'
    : `umask 077 && /usr/bin/flock -n -E 75 ${shellQuote(`${options.remoteDir}/.quality-report.lock`)} /usr/bin/node --input-type=module`;
  const program = `try { await (${remoteMain.toString()})(${JSON.stringify({ ...options, bundle })}); } catch (error) { process.stderr.write(error.message + '\\n'); process.exitCode = 1; }\n`;
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', options.host, command], { input: program, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status === 75) throw new Error('quality report lock is busy; no deployment performed');
  if (result.status !== 0) throw new Error(`remote quality deployment exited ${result.status}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`deploy-quality-report: ${error.message}\n`); process.exitCode = 1; });
}
