'use strict';
// Vercel function entry point. vercel.json rewrites every path to this function,
// so the public URL is just https://<project>.vercel.app/
const { handle } = require('../src/server');

module.exports = (req, res) => handle(req, res);
