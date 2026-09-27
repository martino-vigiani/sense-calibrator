'use strict';

// Il sandbox di alcuni runner vieta ogni listen(), anche su socket Unix.
// Questa via opzionale esercita la stessa app Express e il suo parser JSON
// senza aprire una porta; il percorso predefinito dei test resta quello TCP.
const http = require('node:http');
const { PassThrough } = require('node:stream');

function decodeBody(raw) {
  const separator = raw.indexOf('\r\n\r\n');
  if (separator < 0) throw new Error('In-process HTTP response has no header terminator');
  return raw.subarray(separator + 4);
}

function createInProcessFetch(app) {
  return async function inProcessFetch(url, init = {}) {
    const target = new URL(url);
    const method = init.method || 'GET';
    const body = init.body == null ? null : Buffer.from(init.body);
    const headers = new Headers(init.headers);
    headers.set('Host', target.host);
    if (body && !headers.has('Content-Length')) headers.set('Content-Length', String(body.length));

    const socket = new PassThrough();
    socket.remoteAddress = '127.0.0.1';
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = target.pathname + target.search;
    req.headers = Object.fromEntries(headers.entries());
    // In un vero server il parser ha gia terminato l'HTTP request quando
    // body-parser legge il body. Senza complete, il secondo parser rilegge EOF.
    req.complete = true;
    req._read = () => {};
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    const chunks = [];
    socket.on('data', chunk => chunks.push(Buffer.from(chunk)));

    return new Promise((resolve, reject) => {
      socket.once('error', reject);
      res.once('error', reject);
      res.once('finish', () => {
        try {
          const raw = Buffer.concat(chunks);
          const payload = decodeBody(raw);
          const status = res.statusCode;
          const response = new Response([204, 205, 304].includes(status) ? null : payload, {
            status,
            headers: res.getHeaders(),
          });
          socket.destroy();
          resolve(response);
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      });
      app(req, res);
      setImmediate(() => {
        if (body) req.push(body);
        req.push(null);
      });
    });
  };
}

module.exports = { createInProcessFetch };
