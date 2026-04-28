import { loggerFactory } from '../../server/logger.js';
import { TestController } from './test.controller.js';
import express from 'express';

const logger = loggerFactory(import.meta);

class TestRouter {
  /**
   * Builds and returns the Express Router for this API.
   * @param {import('../../server/auth.js').RouterOptions} options
   * @returns {import('express').Router}
   * @memberof TestRouter
   */
  static router(options) {
  const router = express.Router();
  const { authMiddleware } = options;
  router.post(`/:id`, async (req, res) => await TestController.post(req, res, options));
  router.post(`/`, authMiddleware, async (req, res) => await TestController.post(req, res, options));
  router.get(`/:id`, async (req, res) => await TestController.get(req, res, options));
  router.get(`/`, async (req, res) => await TestController.get(req, res, options));
  router.delete(`/:id`, async (req, res) => await TestController.delete(req, res, options));
  router.delete(`/`, async (req, res) => await TestController.delete(req, res, options));
  return router;
  }
}

const ApiRouter = (options) => TestRouter.router(options);

export { ApiRouter, TestRouter };
