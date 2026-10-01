import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Regressione health del deploy: `curl ... && echo` è escluso da `set -e`;
// un 502 persistente lasciava uscire 0 e stampava "deploy completato".
// Il vero script gira in una cartella temporanea con tutti i confini IO
// sostituiti: niente rete, npm reale, VPS, rsync o attese di tempo reale.
function makeDeploymentHarness(t, { failuresBeforeSuccess }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sense-deploy-telemetry-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const scripts = path.join(root, 'scripts');
  const trace = path.join(root, 'commands.log');
  const attempts = path.join(root, 'health-attempts');
  fs.mkdirSync(bin);
  fs.mkdirSync(scripts);
  fs.mkdirSync(path.join(root, 'server', 'calib-telemetry'), { recursive: true });
  const script = path.join(scripts, 'deploy-telemetry-server.sh');
  fs.copyFileSync(new URL('../scripts/deploy-telemetry-server.sh', import.meta.url), script);
  for (const name of ['npm', 'rsync', 'ssh', 'sleep']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$SC_DEPLOY_TEST_TRACE"\nexit 0\n`, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
count=0
if [ -f "$SC_DEPLOY_TEST_ATTEMPTS" ]; then IFS= read -r count < "$SC_DEPLOY_TEST_ATTEMPTS"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$SC_DEPLOY_TEST_ATTEMPTS"
printf '%s\\n' 'curl' >> "$SC_DEPLOY_TEST_TRACE"
if [ "$SC_DEPLOY_TEST_FAILURES" = 'always' ] || [ "$count" -le "$SC_DEPLOY_TEST_FAILURES" ]; then
  printf '%s\\n' 'curl: (22) The requested URL returned error: 502' >&2
  exit 22
fi
printf '%s\\n' '{"ok":true}'
`, { mode: 0o700 });
  return {
    run: () => spawnSync('bash', [script], {
      cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        SC_DEPLOY_TEST_TRACE: trace, SC_DEPLOY_TEST_ATTEMPTS: attempts,
        SC_DEPLOY_TEST_FAILURES: String(failuresBeforeSuccess) },
    }),
    commands: () => fs.readFileSync(trace, 'utf8').trim().split('\n'),
    healthAttempts: () => Number(fs.readFileSync(attempts, 'utf8').trim()),
  };
}

test('persistent HTTP health failure exits nonzero without claiming deployment completed', t => {
  const h = makeDeploymentHarness(t, { failuresBeforeSuccess: 'always' });

  const result = h.run();

  assert.equal(result.error, undefined, 'the bounded health loop terminates without a harness timeout');
  assert.notEqual(result.status, 0, 'a persistent 502 must fail the deployment command');
  assert.doesNotMatch(result.stdout, /✓ deploy completato/);
  assert.match(result.stderr, /502/);
  assert.equal(h.healthAttempts(), 5, 'five failures exhaust the health retry budget');
  assert.equal(h.commands().filter(command => command === 'ssh').length, 1, 'health retries never redeploy the service');
});

test('two transient HTTP health failures followed by success complete deployment on the third attempt', t => {
  const h = makeDeploymentHarness(t, { failuresBeforeSuccess: 2 });

  const result = h.run();

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(h.healthAttempts(), 3, 'the existing deployment waits for successful health before announcing completion');
  assert.match(result.stdout, /\{"ok":true\}/);
  assert.match(result.stdout, /✓ deploy completato/);
  assert.equal(h.commands().filter(command => command === 'ssh').length, 1);
  assert.equal(h.commands().filter(command => command === 'sleep').length, 2, 'only failed health checks require a retry wait');
});
