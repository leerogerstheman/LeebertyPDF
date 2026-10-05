'use strict';
/**
 * Electron entry point.
 *
 * `package.json` points here. The main script must stay a single concrete file
 * because Electron only hands the real API to the script named by `main`; this
 * file therefore forwards to the two real entry points.
 *
 * The application name is pinned here, before anything reads `app.getPath`, so
 * the user-data directory, the native menu and the About panel all agree on it
 * regardless of how the runtime was launched.
 */
const { app } = require('electron');

const PRODUCT_NAME = 'LeebertyPDF';
app.setName(PRODUCT_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.leeberty.pdf');

require(process.env.LUMEN_TOOL ? './tool-main.js' : './main.js');
