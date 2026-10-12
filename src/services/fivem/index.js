/**
 * FiveM servis paketi — tek giriş noktası.
 * Komutlar ve handler'lar buradan import eder.
 */
const client = require('./client');
const parser = require('./parser');
const service = require('./service');
const pagination = require('./pagination');
const rcon = require('./rcon');
const rconParser = require('./rconParser');

module.exports = { client, parser, service, pagination, rcon, rconParser };
