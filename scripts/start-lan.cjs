const path = require('node:path');

process.env.LAN_MODE = '1';
process.env.HOST = '0.0.0.0';
process.env.PORT = process.env.PORT || '4174';
process.argv[1] = path.resolve(__dirname, '../dist-electron/server.cjs');
require('../dist-electron/server.cjs');
