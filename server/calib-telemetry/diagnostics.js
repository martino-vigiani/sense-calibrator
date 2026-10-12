'use strict';

// Report diagnostici di Sense-Calibrator (POST /api/calib/v2/diagnostics).
//
// Il contratto è contract/diagnostics-v1.schema.json, copia identica byte per
// byte di quello del sito (ops/calib-telemetry/contract/): i due test ne
// fissano la stessa impronta SHA-256 e girano le stesse fixture. Si valida con
// lo stesso sottoinsieme di JSON Schema degli eventi v2; gli eventi `calib`
// dentro il report passano anche dal contratto v2.
//
// Un report si salva in un file per codice (`SC-` + 8 caratteri base32), 600,
// in una cartella 700. Il server aggiunge solo `receivedDay` (data UTC, niente
// ora). Mai IP, user-agent, header o altri metadati della richiesta.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { validateEventV2, validateSchema } = require('./events-v2');

const DIAGNOSTICS_SCHEMA = require('./contract/diagnostics-v1.schema.json');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CODE_RE = /^SC-[A-Z2-7]{8}$/;
const FILE_RE = /^SC-[A-Z2-7]{8}\.json$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function validateDiagnostics(report) {
  const error = validateSchema(report, DIAGNOSTICS_SCHEMA);
  if (error) return error;
  for (let i = 0; i < report.events.length; i++) {
    const e = report.events[i];
    if (e.type !== 'calib') continue;
    const inner = validateEventV2(e.event);
    if (inner) return `$.events[${i}].event${inner.slice(1)}`;
  }
  return null;
}

// 40 bit casuali → 8 caratteri base32 (RFC 4648, senza padding).
function newCode() {
  const bytes = crypto.randomBytes(5);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 7; i >= 0; i--) out += BASE32[Number((bits >> BigInt(i * 5)) & 31n)];
  return `SC-${out}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir non cambia i permessi di una cartella che esiste già.
  fs.chmodSync(dir, 0o700);
}

// Byte e numero dei report nella cartella (solo i file con il nome dei codici).
function dirUsage(dir) {
  let bytes = 0;
  let count = 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return { bytes, count };
    throw e;
  }
  for (const name of names) {
    if (!FILE_RE.test(name)) continue;
    try {
      bytes += fs.statSync(path.join(dir, name)).size;
      count += 1;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return { bytes, count };
}

// Scrive il report con un codice nuovo; `wx` non sovrascrive mai un report
// esistente (una collisione su 40 bit è improbabile, ma si riprova).
function saveReport(dir, report, now = new Date()) {
  ensureDir(dir);
  const record = { ...JSON.parse(JSON.stringify(report)), receivedDay: now.toISOString().slice(0, 10) };
  const body = `${JSON.stringify(record)}\n`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    try {
      fs.writeFileSync(path.join(dir, `${code}.json`), body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return code;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('could not allocate a report code');
}

// Cancella i report più vecchi di `maxAgeDays` (data di modifica del file).
// Tocca solo i file con il nome dei codici. Ritorna quanti ne ha tolti.
function cleanupReports(dir, { maxAgeDays = 180, now = Date.now() } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
  let removed = 0;
  for (const name of names) {
    if (!FILE_RE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeDays * DAY_MS) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return removed;
}

module.exports = {
  DIAGNOSTICS_SCHEMA, CODE_RE, validateDiagnostics, newCode, dirUsage, saveReport, cleanupReports,
};
