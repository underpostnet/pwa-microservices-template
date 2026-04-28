import { adminGuard } from '../../server/auth.js';
import { loggerFactory } from '../../server/logger.js';
import { FileController } from './file.controller.js';
import express from 'express';
const logger = loggerFactory(import.meta);

class FileRouter {
  /**
   * Builds and returns the Express Router for this API.
   * @param {import('../../server/auth.js').RouterOptions} options
   * @returns {import('express').Router}
   * @memberof FileRouter
   */
  static router(options) {
  const router = express.Router();
  const { authMiddleware } = options;
  router.post(`/:id`, authMiddleware, async (req, res) => await FileController.post(req, res, options));
  router.post(`/`, authMiddleware, async (req, res) => await FileController.post(req, res, options));
  router.get(`/blob/:id`, async (req, res) => await FileController.get(req, res, options));
  router.get(`/:id`, async (req, res) => await FileController.get(req, res, options));
  router.get(`/`, async (req, res) => await FileController.get(req, res, options));
  router.delete(`/:id`, authMiddleware, adminGuard, async (req, res) => await FileController.delete(req, res, options));
  router.delete(`/`, authMiddleware, adminGuard, async (req, res) => await FileController.delete(req, res, options));
  return router;
  }
}

const ApiRouter = (options) => FileRouter.router(options);

export { ApiRouter, FileRouter };
