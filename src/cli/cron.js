/**
 * UnderpostCron CLI index module
 * @module src/cli/cron.js
 * @namespace UnderpostCron
 */

import Underpost from '../index.js';
import BackUp from '../server/backup.js';
import { Cmd } from '../server/conf.js';
import Dns from '../server/dns.js';
import { netWorkCron, saveRuntimeCron } from '../server/network.js';
import { shellExec } from '../server/process.js';
import fs from 'fs-extra';

/**
 * UnderpostCron main module methods
 * @class
 * @memberof UnderpostCron
 */
class UnderpostCron {
  static JOB = {
    /**
     * DNS cli API
     * @static
     * @type {Dns}
     * @memberof UnderpostCron
     */
    dns: Dns,
    /**
     * BackUp cli API
     * @static
     * @type {BackUp}
     * @memberof UnderpostCron
     */
    backup: BackUp,
  };
  static API = {
    /**
     * Run the cron jobs
     * @static
     * @param {String} deployList - Comma separated deploy ids
     * @param {String} jobList - Comma separated job ids
     * @return {void}
     * @memberof UnderpostCron
     */
    callback: async function (
      deployList = 'default',
      jobList = Object.keys(UnderpostCron.JOB),
      options = { itc: false, init: false },
    ) {
      if (options.init === true) {
        await Underpost.test.setUpInfo();
        const jobDeployId = fs.readFileSync('./engine-private/deploy/dd.cron', 'utf8').trim();
        deployList = fs.readFileSync('./engine-private/deploy/dd.router', 'utf8').trim();
        const confCronConfig = JSON.parse(fs.readFileSync(`./engine-private/conf/${jobDeployId}/conf.cron.json`));
        if (confCronConfig.jobs && Object.keys(confCronConfig.jobs).length > 0) {
          for (const job of Object.keys(confCronConfig.jobs)) {
            const name = `${jobDeployId}-${job}`;
            let deployId;
            shellExec(Cmd.delete(name));
            switch (job) {
              case 'dns':
                deployId = jobDeployId;
                break;

              default:
                deployId = deployList;
                break;
            }
            shellExec(Cmd.cron(deployId, job, name, confCronConfig.jobs[job].expression, options));
            netWorkCron.push({
              deployId,
              jobId: job,
              expression: confCronConfig.jobs[job].expression,
            });
          }
        }
        await saveRuntimeCron();
        if (fs.existsSync(`./tmp/await-deploy`)) fs.remove(`./tmp/await-deploy`);
        return;
      }
      for (const _jobId of jobList.split(',')) {
        const jobId = _jobId.trim();
        if (UnderpostCron.JOB[jobId]) await UnderpostCron.JOB[jobId].callback(deployList, options);
      }
    },
  };
}

export default UnderpostCron;
