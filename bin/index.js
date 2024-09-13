#!node ./node_modules/underpost/bin

import { loggerFactory } from '../src/server/logger.js';
import dotenv from 'dotenv';
import { shellCd, shellExec } from '../src/server/process.js';
import fs from 'fs-extra';

dotenv.config();

const logger = loggerFactory(import.meta);

await logger.setUpInfo();

switch (process.argv[3]) {
  case 'new':
    const projectName = process.argv[4] || 'my-project';
    fs.mkdirSync(projectName, { recursive: true });
    fs.copySync(`./node_modules/underpost`, `./${projectName}`);
    shellCd(`${projectName}`);
    shellExec(`npm run install-template`);
    shellExec(`npm run dev`);
    break;
  default:
    break;
}
