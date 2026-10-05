'use strict';
/**
 * Development tool mode (see tools/README.md).
 *
 * Launch with `LUMEN_TOOL=<name>.js` in the environment to run a script from
 * `tools/` with the Electron app object, without booting the reader UI.
 */
const path = require('path');

const APP_DIR = path.join(__dirname, '..', '..');
const name = process.env.LUMEN_TOOL;
const target = path.isAbsolute(name) ? name : path.join(APP_DIR, 'tools', name);

try {
  require(target);
} catch (err) {
  console.error(`[lumen] tool "${name}" failed:`, err);
  process.exit(1);
}
