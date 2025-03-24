import { getNpmRootPath, writeEnv } from '../server/conf.js';
import fs from 'fs-extra';
import { loggerFactory } from '../server/logger.js';
import dotenv from 'dotenv';

dotenv.config();

const logger = loggerFactory(import.meta);

class UnderpostRootEnv {
  static API = {
    set(key, value) {
      const exeRootPath = `${getNpmRootPath()}/underpost`;
      const envPath = `${exeRootPath}/.env`;
      let env = {};
      if (fs.existsSync(envPath)) env = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
      env[key] = value;
      writeEnv(envPath, env);
    },
    delete(key) {
      const exeRootPath = `${getNpmRootPath()}/underpost`;
      const envPath = `${exeRootPath}/.env`;
      let env = {};
      if (fs.existsSync(envPath)) env = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
      delete env[key];
      writeEnv(envPath, env);
    },
    get(key) {
      const exeRootPath = `${getNpmRootPath()}/underpost`;
      const envPath = `${exeRootPath}/.env`;
      if (!fs.existsSync(envPath)) return logger.error(`Unable to find underpost root environment`);
      const env = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
      logger.info(`${key}(${typeof env[key]})`, env[key]);
      return env[key];
    },
    list() {
      const exeRootPath = `${getNpmRootPath()}/underpost`;
      const envPath = `${exeRootPath}/.env`;
      if (!fs.existsSync(envPath)) return logger.error(`Unable to find underpost root environment`);
      const env = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
      logger.info('underpost root', env);
      return env;
    },
    clean() {
      const exeRootPath = `${getNpmRootPath()}/underpost`;
      const envPath = `${exeRootPath}/.env`;
      fs.removeSync(envPath);
    },
  };
}

export default UnderpostRootEnv;
