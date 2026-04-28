/**
 * Module for formatting client-side code using esbuild for import rewriting and minification.
 * @module src/server/client-formatted.js
 * @namespace clientFormatted
 */

'use strict';

import * as esbuild from 'esbuild';
import fs from 'fs-extra';
import * as path from 'path';

/**
 * Escapes a string for safe use inside a RegExp.
 * @param {string} s - The string to escape.
 * @returns {string} The escaped string.
 * @memberof clientFormatted
 */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Formats a source code string by removing 'html`' and 'css`' tagged template prefixes.
 * Used for SSR VM execution where the full esbuild pipeline is not needed.
 * @param {string} src - The source code string.
 * @returns {string} The formatted source code.
 * @memberof clientFormatted
 */
const srcFormatted = (src) => src.replace(/(?<=[\s({[,;=+!?:^])(html|css)`/g, '`');

/**
 * Converts a JavaScript object into a string that can be embedded in client-side code
 * and parsed back into an object (e.g., 'JSON.parse(`{...}`)').
 * Escapes backticks and template expression markers for safe template literal embedding.
 * @param {*} data - The data to be stringified.
 * @returns {string} A string representing the code to parse the JSON data.
 * @memberof clientFormatted
 */
const JSONweb = (data) => {
  const json = JSON.stringify(data).replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return 'JSON.parse(`' + json + '`)';
};

/**
 * Creates an esbuild plugin that rewrites import paths for browser consumption.
 * Handles dist library imports, relative imports, and marks all remaining imports as external.
 * @param {object} options
 * @param {Array<object>} [options.dists=[]] - Distribution objects with import_name and import_name_build.
 * @param {string} options.proxyPath - The proxy path for the application.
 * @param {string} [options.basePath=''] - The base path for the module type (e.g., 'components', 'services').
 * @param {string} [options.module=''] - The module/component name for relative import resolution.
 * @param {string} [options.baseHost=''] - The base host URL.
 * @returns {import('esbuild').Plugin}
 * @memberof clientFormatted
 */
const importRewritePlugin = ({ dists = [], proxyPath, basePath = '', module = '', baseHost = '' }) => ({
  name: 'import-rewrite',
  setup(build) {
    const prefix = `${baseHost}${proxyPath !== '/' ? `${proxyPath}/` : '/'}`;

    // Rewrite dist library imports (e.g., '@neodrag/vanilla' → '/proxyPath/dist/@neodrag-vanilla/index.js')
    if (dists) {
      for (const dist of dists) {
        if (!dist.import_name) continue;
        const filter = new RegExp(`^${escapeRegExp(dist.import_name)}$`);
        build.onResolve({ filter }, () => ({
          path: `${baseHost}${proxyPath !== '/' ? proxyPath : ''}${dist.import_name_build}`,
          external: true,
        }));
      }
    }

    // Rewrite relative imports to absolute paths based on proxy path and module
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      const basePrefix = `${prefix}${basePath ? `${basePath}/` : ''}`;
      if (args.path.startsWith('./')) {
        return {
          path: `${basePrefix}${module ? `${module}/` : ''}${args.path.slice(2)}`,
          external: true,
        };
      }
      if (args.path.startsWith('../')) {
        return {
          path: `${basePrefix}${args.path.slice(3)}`,
          external: true,
        };
      }
    });

    // Mark any remaining imports as external
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point') return;
      return { path: args.path, external: true };
    });
  },
});

/**
 * Transforms a JavaScript source file using esbuild with import path rewriting,
 * tagged template stripping, and optional minification.
 * Replaces the previous srcFormatted + componentFormatted/viewFormatted + UglifyJS pipeline.
 * @param {string} srcPath - Path to the source file.
 * @param {object} options
 * @param {Array<object>} [options.dists=[]] - Distribution objects with import names.
 * @param {string} options.proxyPath - The proxy path for the application.
 * @param {string} [options.basePath=''] - Base path for the module type (e.g., 'components', 'services').
 * @param {string} [options.module=''] - Module name for relative import resolution.
 * @param {string} [options.baseHost=''] - Base host URL.
 * @param {boolean} [options.minify=false] - Whether to minify the output.
 * @returns {Promise<string>} The transformed source code.
 * @memberof clientFormatted
 */
const transformClientJs = async (
  srcPath,
  { dists = [], proxyPath, basePath = '', module = '', baseHost = '', minify: shouldMinify = false } = {},
) => {
  const src = fs.readFileSync(srcPath, 'utf8');
  const stripped = srcFormatted(src);

  const result = await esbuild.build({
    stdin: {
      contents: stripped,
      loader: 'js',
      resolveDir: path.dirname(path.resolve(srcPath)),
      sourcefile: path.basename(srcPath),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'esnext',
    minify: shouldMinify,
    logLevel: 'warning',
    plugins: [importRewritePlugin({ dists, proxyPath, basePath, module, baseHost })],
  });

  return result.outputFiles[0].text;
};

/**
 * Transforms a **service-worker** source file using esbuild, bundling all npm
 * dependencies (e.g. Workbox) directly into the output file.
 *
 * Unlike `transformClientJs`, this function does NOT use `importRewritePlugin`.
 * All `import` statements from `node_modules` are resolved and inlined by
 * esbuild, producing a self-contained SW bundle with no external dependencies.
 *
 * The resulting string is written to `sw.js` and then prepended with
 * `self.renderPayload = …` by the calling build step.
 *
 * @param {string} srcPath - Path to the SW source file (e.g. `workbox.sw.js`).
 * @param {object} [options]
 * @param {boolean} [options.minify=false] - Whether to minify the output.
 * @returns {Promise<string>} The bundled SW source code.
 * @memberof clientFormatted
 */
const transformSwBundle = async (srcPath, { minify: shouldMinify = false } = {}) => {
  const src = fs.readFileSync(srcPath, 'utf8');
  const stripped = srcFormatted(src);

  const result = await esbuild.build({
    stdin: {
      contents: stripped,
      loader: 'js',
      resolveDir: path.dirname(path.resolve(srcPath)),
      sourcefile: path.basename(srcPath),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'esnext',
    minify: shouldMinify,
    logLevel: 'warning',
    // No importRewritePlugin: all npm modules (Workbox, etc.) are inlined.
  });

  return result.outputFiles[0].text;
};

export { srcFormatted, JSONweb, transformClientJs, transformSwBundle };
