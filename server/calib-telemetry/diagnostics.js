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
// ora) e porta la data di modifica del file alla mezzanotte UTC dello stesso
// giorno, così l'ora di ricezione non resta nemmeno nel filesystem. Mai IP,
// user-agent, header o altri metadati della richiesta.

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

const dayStartMs = ms => Math.floor(ms / DAY_MS) * DAY_MS;

// Il file com'è salvato: il report più `receivedDay`. Il server ne usa la
// lunghezza per le quote prima di scriverlo.
function reportRecord(report, now = new Date()) {
  const record = { ...JSON.parse(JSON.stringify(report)), receivedDay: now.toISOString().slice(0, 10) };
  return `${JSON.stringify(record)}\n`;
}

// Scrive il record con un codice nuovo; `wx` non sovrascrive mai un report
// esistente (una collisione su 40 bit è improbabile, ma si riprova). Se non si
// riesce a togliere l'ora dal mtime il file non resta.
function saveReport(dir, body, now = new Date()) {
  ensureDir(dir);
  const midnight = dayStartMs(now.getTime()) / 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    const file = path.join(dir, `${code}.json`);
    try {
      fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    try {
      fs.utimesSync(file, midnight, midnight);
    } catch (e) {
      try { fs.unlinkSync(file); } catch { /* già sparito */ }
      throw e;
    }
    return code;
  }
  throw new Error('could not allocate a report code');
}

// Una passata sulla cartella: cancella i report più vecchi di `maxAgeDays`
// (mtime, cioè la mezzanotte UTC del giorno di ricezione) e conta quelli che
// restano, in totale e ricevuti oggi (UTC). Tocca solo i file con il nome dei
// codici. Il server la chiama all'avvio e una volta al giorno; in mezzo tiene i
// totali in memoria.
function scanReports(dir, { maxAgeDays = 180, now = Date.now() } = {}) {
  const out = { removed: 0, bytes: 0, count: 0, dayCount: 0, dayBytes: 0 };
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return out;
    throw e;
  }
  const today = dayStartMs(now);
  for (const name of names) {
    if (!FILE_RE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > maxAgeDays * DAY_MS) {
        fs.unlinkSync(file);
        out.removed += 1;
        continue;
      }
      out.bytes += stat.size;
      out.count += 1;
      if (stat.mtimeMs >= today) {
        out.dayBytes += stat.size;
        out.dayCount += 1;
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return out;
}

module.exports = {
  DIAGNOSTICS_SCHEMA, CODE_RE, DAY_MS, dayStartMs, validateDiagnostics, newCode, reportRecord, saveReport, scanReports,
};
