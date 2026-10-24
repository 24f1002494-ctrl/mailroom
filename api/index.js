'use strict';
// Vercel function entry point. vercel.json rewrites every path to this function,
// so the public URL is just https://<project>.vercel.app/
// Startup errors are returned as JSON (instead of FUNCTION_INVOCATION_FAILED) so they can be diagnosed.
let handle = null;
let bootError = null;
try {
  ({ handle } = require('../src/core'));
} catch (e) {
  bootError = e;
  console.error('boot failed:', (e && e.stack) || e);
}

module.exports = async (req, res) => {
  if (bootError) {
    const body = JSON.stringify({ error: { code: 'boot_failed', message: String(bootError && bootError.message || bootError).slice(0, 400) } });
    res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    return res.end(body);
  }
  try {
    return await handle(req, res);
  } catch (e) {
    console.error('handler crashed:', (e && e.stack) || e);
    if (!res.headersSent) {
      const body = JSON.stringify({ error: { code: 'handler_crashed', message: String(e && e.message || e).slice(0, 400) } });
      res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    }
  }
};
