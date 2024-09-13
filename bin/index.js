import { spawn } from 'node:child_process';
import { loggerFactory } from '../src/server/logger.js';

const logger = loggerFactory(import.meta);

const underpost = spawn('underpost', ['build', 'run']);

underpost.stdout.on('data', (data) => {
  logger.info(`stdout`, data);
});

underpost.stderr.on('data', (data) => {
  logger.error(`stderr`, data);
});

underpost.on('close', (code) => {
  logger.info(`child process exited with code`, code);
});
