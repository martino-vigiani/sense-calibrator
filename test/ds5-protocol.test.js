import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DS5, HID_REPLY_TIMEOUT_MS, NV_UNKNOWN_MESSAGE, POISONED_MESSAGE, isOldFirmware, parseBuildDate,
} from '../js/ds5.js';
import { VClock } from '../ops/sim/vclock.mjs';

// Protocollo DS5 contro un dispositivo WebHID sceneggiato: ogni risposta
// 0x81/0x83 è scritta dal test, le latenze girano su un orologio virtuale.
// Nessun controller fisico: questi test descrivono il comportamento del codice,
// non quello del firmware (le verifiche hardware sono H1, H3, H13).

const NV = { locked: 0x03030201, unlocked: 0x03030200 };
const word = w => [(w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff];

// reply(id, log) → array di byte, oppure { hang: true } (nessuna risposta
// finché il test non chiama `release`), oppure { delay, bytes }.
class ScriptedDevice {
  constructor(clock, { reply, sendFails = () => null } = {}) {
    this.clock = clock;
    this.opened = true;
    this.collections = [{ inputReports: [{ reportId: 0x01 }], featureReports: [] }];
    this.sent = [];
    this.events = [];
    this.pending = [];
    this.reply = reply ?? (() => [0x83, 1, 1, 1]);
    this.sendFails = sendFails;
    this.nv = 'locked';
  }
  sendFeatureReport(id, buf) {
    const bytes = [...buf];
    this.events.push(['send', id, bytes.slice(0, 2).join(',')]);
    const error = this.sendFails(id, bytes);
    if (error === 'hang') return new Promise(() => {});
    if (error) return Promise.reject(error);
    this.sent.push({ id, bytes });
    if (id === 0x80 && bytes[0] === 3 && bytes[1] === 2) this.nv = 'unlocked';
    if (id === 0x80 && bytes[0] === 3 && bytes[1] === 1) this.nv = 'locked';
    return new Promise(r => this.clock.setTimeout(r, 2));
  }
  receiveFeatureReport(id) {
    this.events.push(['recv', id]);
    const out = this.reply(id, this.sent.at(-1), this);
    const view = bytes => { const b = new Uint8Array(63); b.set(bytes); return new DataView(b.buffer); };
    if (out?.hang) {
      return new Promise(resolve => { this.pending.push(bytes => resolve(view(bytes))); });
    }
    const bytes = Array.isArray(out) ? out : out.bytes;
    const delay = Array.isArray(out) ? 3 : out.delay;
    return new Promise(resolve => this.clock.setTimeout(() => resolve(view(bytes)), delay));
  }
  // Consegna in ritardo la risposta a un receive rimasto appeso.
  release(bytes) { this.pending.shift()?.(bytes); }
}

function setup(options) {
  const clock = new VClock();
  const dev = new ScriptedDevice(clock, options);
  const poisons = [];
  const ds5 = new DS5(dev, null, { timers: clock, onPoison: error => poisons.push(error) });
  const run = promise => clock.run(Promise.resolve(promise).then(v => ({ ok: v }), e => ({ error: e })));
  return { clock, dev, ds5, poisons, run };
}

// Risposte "sane": 0x83 coerente con l'ultimo comando 0x82, 0x81 con la parola NVS.
function healthy(overrides = {}) {
  return (id, last, dev) => {
    if (overrides[id]) {
      const out = overrides[id](last, dev);
      if (out !== undefined) return out;
    }
    if (id === 0x83) {
      const [op, , target] = last.bytes;
      return [0x83, 1, target, op === 3 ? 1 : op];
    }
    if (id === 0x81) return [0x81, ...word(NV[dev.nv])];
    return [id];
  };
}

// ------------------------------------------------------------ timeout e poison

test('a missing reply rejects within 1.1 s and poisons the device', async () => {
  const { clock, ds5, poisons, run } = setup({ reply: healthy({ 0x83: () => ({ hang: true }) }) });
  const t0 = clock.now();
  const { error } = await run(ds5.calibSample());
  assert.ok(error, 'the command rejects instead of hanging');
  assert.ok(clock.now() - t0 <= 1100, `rejected after ${clock.now() - t0} ms`);
  assert.ok(clock.now() - t0 >= HID_REPLY_TIMEOUT_MS);
  assert.equal(error.timeout, true);
  assert.equal(error.poisoned, true);
  assert.equal(error.committed, undefined, 'a sample is not a commit');
  assert.ok(ds5.poisoned);
  assert.equal(poisons.length, 1);
});

test('after a timeout no further command reaches the device, and a late reply is never read', async () => {
  const { dev, ds5, run } = setup({ reply: healthy({ 0x83: (last, d) => (d.sent.length === 1 ? { hang: true } : undefined) }) });
  await run(ds5.calibBegin().catch(() => {}));
  const sentBefore = dev.sent.length;
  // La risposta al comando scaduto arriva adesso, in ritardo.
  dev.release([0x83, 1, 1, 2]);
  const { error } = await run(ds5.calibEnd());
  assert.equal(error.poisoned, true);
  assert.equal(error.message, POISONED_MESSAGE);
  assert.equal(dev.sent.length, sentBefore, 'nothing is sent on a poisoned connection');
  assert.equal((await run(ds5.queryNvStatus())).ok.status, 'error');
  assert.equal(dev.sent.length, sentBefore, 'not even the read-only NVS query');
});

test('a send that never completes also times out and poisons', async () => {
  const { ds5, run } = setup({ sendFails: () => 'hang' });
  const { error } = await run(ds5.calibBegin());
  assert.equal(error.timeout, true);
  assert.ok(ds5.poisoned);
});

test('timeouts on commit commands count as committed; on begin and sample they do not', async () => {
  const cases = [
    ['calibEnd', ds5 => ds5.calibEnd(), 0x83, true],
    ['rangeEnd', ds5 => ds5.rangeEnd(), 0x83, true],
    ['nvsUnlock', ds5 => ds5.nvsUnlock(), 0x81, true],
    ['nvsLock', ds5 => ds5.nvsLock(), 0x81, true],
    ['calibBegin', ds5 => ds5.calibBegin(), 0x83, false],
    ['calibSample', ds5 => ds5.calibSample(), 0x83, false],
    ['rangeBegin', ds5 => ds5.rangeBegin(), 0x83, false],
  ];
  for (const [name, call, replyId, committed] of cases) {
    const { ds5, poisons, run } = setup({ reply: healthy({ [replyId]: () => ({ hang: true }) }) });
    const { error } = await run(call(ds5));
    assert.equal(error?.timeout, true, name);
    assert.equal(error.committed === true, committed, `${name} committed`);
    assert.equal(poisons[0].committed === true, committed, `${name}: onPoison sees the same flag`);
  }
});

test('a commit whose reply fails after the send went out is still reported as committed', async () => {
  const { ds5, run } = setup({ reply: healthy({ 0x83: () => { throw new Error('device closed'); } }) });
  const { error } = await run(ds5.calibEnd());
  assert.equal(error.committed, true);
  assert.equal(ds5.poisoned, null, 'an I/O error is not a timeout: no poison');
});

test('a calibBegin repair whose calibEnd times out reports committed on the thrown error', async () => {
  let n = 0;
  const { ds5, run } = setup({
    reply: healthy({
      0x83: last => {
        n += 1;
        if (n === 1) return [0x83, 0, 0, 0]; // begin rifiutato: sessione stantia
        if (last.bytes[0] === 2) return { hang: true }; // il calibEnd di riparazione non risponde
        return undefined;
      },
    }),
  });
  const { error } = await run(ds5.calibBegin());
  assert.ok(error);
  assert.equal(error.committed, true);
  assert.ok(ds5.poisoned);
});

test('calibBegin({ repair: false }) never sends the repair calibEnd: a refused begin fails with openSession', async () => {
  const { dev, ds5, run } = setup({
    reply: healthy({ 0x83: () => [0x83, 0, 0, 0] }), // begin rifiutato: sessione aperta
  });
  const { error } = await run(ds5.calibBegin({ repair: false }));
  assert.ok(error);
  assert.equal(error.openSession, true);
  assert.equal(error.committed, false);
  const sent82 = dev.events.filter(e => e[0] === 'send' && e[1] === 0x82);
  assert.equal(sent82.length, 1, 'only the begin went out: no calibEnd, no retry');
});

// Review 2: un calibBegin partito ma senza risposta può aver aperto la
// sessione nel firmware. Chi chiama deve vederlo (`openSession`), altrimenti
// dopo un replug la riparazione committerebbe una sessione da 0 campioni.
test('a calibBegin that went out but got no answer is tagged openSession; one that never left is not', async () => {
  for (const [name, options, expected] of [
    ['reply timeout', { reply: healthy({ 0x83: () => ({ hang: true }) }) }, true],
    ['receive error after the send', { reply: healthy({ 0x83: () => { throw new Error('device closed'); } }) }, true],
    ['send timeout', { sendFails: () => 'hang' }, true],
    ['send rejected', { sendFails: () => new Error('NotAllowedError') }, undefined],
  ]) {
    const { ds5, run } = setup(options);
    const { error } = await run(ds5.calibBegin());
    assert.ok(error, name);
    assert.equal(error.openSession, expected, name);
    assert.notEqual(error.committed, true, `${name}: opening a session commits nothing`);
  }
  // Controller avvelenato: nessun byte parte, quindi nessuna sessione.
  const { ds5, run } = setup({ reply: healthy({ 0x83: () => ({ hang: true }) }) });
  await run(ds5.calibSample().catch(() => {}));
  const { error } = await run(ds5.calibBegin());
  assert.equal(error.poisoned, true);
  assert.equal(error.openSession, undefined);
});

test('reboot reports whether it went out: a rejection with the device still open is not a restart', async () => {
  const ok = setup();
  assert.deepEqual((await ok.run(ok.ds5.reboot())).ok, { sent: true });
  const refused = setup({ sendFails: () => new Error('NotAllowedError') });
  assert.equal((await refused.run(refused.ds5.reboot())).ok.sent, false);
  const dropped = setup();
  dropped.dev.sendFeatureReport = () => { dropped.dev.opened = false; return Promise.reject(new Error('device closed')); };
  assert.equal((await dropped.run(dropped.ds5.reboot())).ok.sent, true, 'the controller went away mid-send: expected for a reboot');
});

// ------------------------------------------------------------ mutex

test('request/response pairs never interleave', async () => {
  const { dev, ds5, run } = setup({ reply: healthy() });
  await run(Promise.all([ds5.calibSample(), ds5.queryNvStatus(), ds5.calibSample(), ds5.getSerial()]));
  const kinds = dev.events.map(e => e[0]);
  assert.deepEqual(kinds, ['send', 'recv', 'send', 'recv', 'send', 'recv', 'send', 'recv']);
  // e ogni risposta è letta sul report giusto per la richiesta appena inviata
  const pairs = [];
  for (let i = 0; i < dev.events.length; i += 2) pairs.push([dev.events[i][1], dev.events[i + 1][1]]);
  assert.deepEqual(pairs, [[0x82, 0x83], [0x80, 0x81], [0x82, 0x83], [0x80, 0x81]]);
});

test('a failed command releases the mutex for the next one', async () => {
  let first = true;
  const { ds5, run } = setup({ sendFails: () => (first ? (first = false, new Error('stall')) : null), reply: healthy() });
  const results = await run(Promise.allSettled([ds5.calibSample(), ds5.calibSample()]));
  assert.deepEqual(results.ok.map(r => r.status), ['rejected', 'fulfilled']);
});

// ------------------------------------------------------------ NVS e flash

test('queryNvStatus is a single read-only request', async () => {
  const { dev, ds5, run } = setup({ reply: healthy() });
  assert.equal((await run(ds5.queryNvStatus())).ok.status, 'locked');
  assert.deepEqual(dev.sent.map(s => [s.id, s.bytes[0], s.bytes[1]]), [[0x80, 3, 3]]);
});

test('flash unlocks once and locks once', async () => {
  const { dev, ds5, run } = setup({ reply: healthy() });
  const { error } = await run(ds5.flash());
  assert.equal(error, undefined);
  assert.deepEqual(dev.sent.map(s => s.bytes.slice(0, 2).join(',')), ['3,2', '3,1']);
  assert.equal(dev.nv, 'locked');
});

test('flash rejects an 0x81 reply that does not carry its report id', async () => {
  const { dev, ds5, run } = setup({ reply: healthy({ 0x81: last => (last.bytes[1] === 2 ? [0x00, 0, 0, 0] : undefined) }) });
  const { error } = await run(ds5.flash());
  assert.match(error.message, /NVS unlock failed/);
  assert.match(error.cause.message, /unexpected reply/);
  assert.equal(dev.sent.filter(s => s.bytes[1] === 2).length, 1, 'unlock is never retried');
});

test('if the lock fails after a successful unlock, only the lock is retried, once', async () => {
  let lockFailures = 1;
  const { dev, ds5, run } = setup({
    reply: healthy(),
    sendFails: (id, bytes) => (id === 0x80 && bytes[1] === 1 && lockFailures-- > 0 ? new Error('pipe') : null),
  });
  const { error } = await run(ds5.flash());
  assert.equal(error, undefined, 'the retry succeeded');
  const unlocks = dev.events.filter(e => e[0] === 'send' && e[2] === '3,2').length;
  const locks = dev.events.filter(e => e[0] === 'send' && e[2] === '3,1').length;
  assert.equal(unlocks, 1);
  assert.equal(locks, 2);
  assert.equal(dev.nv, 'locked');
});

test('a lock that fails twice throws without a third attempt and without a second unlock', async () => {
  const { dev, ds5, run } = setup({
    reply: healthy(),
    sendFails: (id, bytes) => (id === 0x80 && bytes[1] === 1 ? new Error('pipe') : null),
  });
  const { error } = await run(ds5.flash());
  assert.match(error.message, /may still be unlocked/);
  assert.equal(dev.events.filter(e => e[0] === 'send' && e[2] === '3,2').length, 1);
  assert.equal(dev.events.filter(e => e[0] === 'send' && e[2] === '3,1').length, 2);
});

test('an unlock failure never sends a lock or a second unlock', async () => {
  const { dev, ds5, run } = setup({
    reply: healthy(),
    sendFails: (id, bytes) => (id === 0x80 && bytes[1] === 2 ? new Error('pipe') : null),
  });
  const { error } = await run(ds5.flash());
  assert.match(error.message, /NVS unlock failed/);
  assert.equal(dev.events.filter(e => e[0] === 'send').length, 1);
});

test('a timeout during flash reports the memory state as unknown and retries nothing', async () => {
  const { dev, ds5, run } = setup({ reply: healthy({ 0x81: last => (last.bytes[1] === 1 ? { hang: true } : undefined) }) });
  const { error } = await run(ds5.flash());
  assert.equal(error.nvUnknown, true);
  assert.equal(error.committed, true);
  assert.equal(error.message, NV_UNKNOWN_MESSAGE);
  assert.equal(dev.events.filter(e => e[0] === 'send' && e[2] === '3,1').length, 1, 'no lock retry after a timeout');
  assert.ok(ds5.poisoned);
});

// ------------------------------------------------------------ range

test('rangeEnd reports code 3 as alreadyClosed instead of hiding it', async () => {
  const closed = setup({ reply: healthy({ 0x83: () => [0x83, 1, 2, 3] }) });
  assert.deepEqual((await closed.run(closed.ds5.rangeEnd())).ok, { alreadyClosed: true });
  const ok = setup({ reply: healthy() });
  assert.deepEqual((await ok.run(ok.ds5.rangeEnd())).ok, { alreadyClosed: false });
  const refused = setup({ reply: healthy({ 0x83: () => [0x83, 1, 2, 5] }) });
  assert.match((await refused.run(refused.ds5.rangeEnd())).error.message, /Failed to close range/);
});

test('audit 07: malformed replies retain openSession/committed and cannot masquerade as command status', async () => {
  for (const [name, call, flag] of [
    ['begin', ds5 => ds5.calibBegin({ repair: false }), 'openSession'],
    ['center end', ds5 => ds5.calibEnd(), 'committed'],
    ['range end', ds5 => ds5.rangeEnd(), 'committed'],
    ['NVS lock', ds5 => ds5.nvsLock(), 'committed'],
  ]) {
    const { dev, ds5, run } = setup();
    dev.receiveFeatureReport = () => Promise.resolve(new DataView(new Uint8Array([0x83]).buffer));
    const { error } = await run(call(ds5));
    assert.equal(error?.[flag], true, `${name}: possible firmware effect survives decode failure`);
  }
  const wrongCommand = setup({ reply: healthy({ 0x83: () => [0x83, 9, 9, 3] }) });
  assert.ok((await wrongCommand.run(wrongCommand.ds5.rangeEnd())).error,
    'code 3 on another command cannot mean already closed');
  const wrongReport = setup({ reply: healthy({ 0x81: () => [0x99, ...word(NV.locked)] }) });
  assert.equal((await wrongReport.run(wrongReport.ds5.queryNvStatus())).ok.status, 'error');
});

test('audit 12: a timed-out Restart poisons the connection before any later HID command', async () => {
  const { dev, ds5, run } = setup({ sendFails: (id, bytes) => id === 0x80 && bytes[0] === 1 ? 'hang' : null });
  const restart = await run(ds5.reboot());
  assert.equal(restart.ok.sent, false);
  assert.equal(restart.ok.error.timeout, true);
  assert.ok(ds5.poisoned);
  const sent = dev.events.length;
  await run(ds5.queryNvStatus());
  assert.equal(dev.events.length, sent, 'late Restart cannot overlap another command');
});

// ------------------------------------------------------------ info dispositivo

test('boardModel maps 0x09 to BDM-060R', () => {
  const ds5 = new DS5({ collections: [] });
  assert.equal(ds5.boardModel(0x0900), 'BDM-060R');
  assert.equal(ds5.boardModel(0x0400), 'BDM-020');
  assert.equal(ds5.boardModel(0x2000), null);
});

test('the firmware build date is parsed locally', () => {
  assert.deepEqual(parseBuildDate('Jun 24 2021'), { year: 2021, month: 6, day: 24 });
  assert.deepEqual(parseBuildDate(' Sep  3 2023 '), { year: 2023, month: 9, day: 3 });
  assert.equal(parseBuildDate('garbage'), null);
  assert.equal(parseBuildDate(null), null);
  assert.equal(isOldFirmware('Nov  5 2020'), true);
  assert.equal(isOldFirmware('Jun 24 2021'), true);
  assert.equal(isOldFirmware('Jan 10 2022'), false);
  assert.equal(isOldFirmware(undefined), false);
});

test('getInfo reads the build date from report 0x20 without writing anything', async () => {
  const report20 = [0x20, ...Buffer.from('Jun 24 2021', 'latin1'), ...Buffer.from('10:20:30', 'latin1')];
  while (report20.length < 64) report20.push(0);
  // hwinfo (LE) all'offset 24: byte 1 = 0x09 → BDM-060R
  report20[24] = 0x00; report20[25] = 0x09;
  const { dev, ds5, run } = setup({
    reply: healthy({ 0x20: () => ({ bytes: report20, delay: 2 }) }),
  });
  // La DataView del fake è lunga 63: allarga a 64 come il descrittore reale.
  const original = dev.receiveFeatureReport.bind(dev);
  dev.receiveFeatureReport = id => (id === 0x20
    ? Promise.resolve(new DataView(Uint8Array.from(report20).buffer))
    : original(id));
  const info = (await run(ds5.getInfo())).ok;
  assert.equal(info.buildDate, 'Jun 24 2021');
  assert.equal(info.buildYear, 2021);
  assert.equal(info.board, 'BDM-060R');
  assert.ok(dev.sent.every(s => s.id === 0x80 && s.bytes[0] === 1 && s.bytes[1] === 19), 'only the serial read is sent');
});
