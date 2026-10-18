import { createApp } from './app.js';
import { config } from './config.js';
import { startWorker } from './jobs.js';

createApp().listen(config.port, () => console.log(`API listening on :${config.port}`));
if (config.runWorkerInProcess) { startWorker(); console.log('in-process worker started'); }
