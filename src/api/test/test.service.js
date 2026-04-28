import validator from 'validator';
import { loggerFactory } from '../../server/logger.js';
import { TestModel } from './test.model.js';
import { getYouTubeID, validatePassword } from '../../client/components/core/CommonJs.js';

const logger = loggerFactory(import.meta);

class TestService {
  static async post(req, res, options) {
    switch (req.params.id) {
      default:
        break;
    }
  }
  static async get(req, res, options) {
    switch (req.params.id) {
      case 'verify-email':
        return validator.isEmail(req.query.email);
      case 'youtube-id':
        return getYouTubeID(req.query.url);
      case 'is-strong-password':
        return validatePassword(req.query.password);

      default:
    }
  }
  static async delete(req, res, options) {
    switch (req.params.id) {
      default:
        break;
    }
  }
}

export { TestService };
