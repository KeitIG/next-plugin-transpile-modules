/**
 * disclaimer:
 *
 * THIS PLUGIN IS A BIG HACK.
 *
 * don't even try to reason about the quality of the following lines of code.
 */

const path = require('path');
const process = require('process');

const enhancedResolve = require('enhanced-resolve');
const escalade = require('escalade/sync');

// Use me when needed
// const util = require('util');
// const inspect = (object) => {
//   console.log(util.inspect(object, { showHidden: false, depth: null }));
// };

const CWD = process.cwd();

/**
 * Check if two regexes are equal
 * Stolen from https://stackoverflow.com/questions/10776600/testing-for-equality-of-regular-expressions
 *
 * @param {RegExp} x
 * @param {RegExp} y
 * @returns {boolean}
 */
const regexEqual = (x, y) => {
  return (
    x instanceof RegExp &&
    y instanceof RegExp &&
    x.source === y.source &&
    x.global === y.global &&
    x.ignoreCase === y.ignoreCase &&
    x.multiline === y.multiline
  );
};

/**
 * Logger for the debug mode
 * @param {boolean} enable enable the logger or not
 * @returns {(message: string, force: boolean) => void}
 */
const createLogger = (enable) => {
  return (message, force) => {
    if (enable || force) console.info(`next-transpile-modules - ${message}`);
  };
};

/**
 * Matcher function for webpack to decide which modules to transpile
 * TODO: could be simplified
 *
 * @param {string[]} modulesToTranspile
 * @param {function} logger
 * @returns {(path: string) => boolean}
 */
const createWebpackMatcher = (modulesToTranspile, logger = createLogger(false)) => {
  // create an array of tuples with each passed in module to transpile and its node_modules depth
  // example: ['/full/path/to/node_modules/button/node_modules/icon', 2]
  const modulePathsWithDepth = modulesToTranspile.map((modulePath) => [
    modulePath,
    (modulePath.match(/node_modules/g) || []).length,
  ]);

  return (filePath) => {
    const nodeModulesDepth = (filePath.match(/node_modules/g) || []).length;

    return modulePathsWithDepth.some(([modulePath, moduleDepth]) => {
      // Ensure we aren't implicitly transpiling nested dependencies by comparing depths of modules to be transpiled and the module being checked
      const transpiled = filePath.startsWith(modulePath) && nodeModulesDepth === moduleDepth;
      if (transpiled) logger(`transpiled: ${filePath}`);
      return transpiled;
    });
  };
};

/**
 * Transpile modules with Next.js Babel configuration
 * @param {string[]} modules
 * @param {{resolveSymlinks?: boolean, debug?: boolean, __unstable_matcher: (path: string) => boolean}} options
 */
const withTmInitializer = (modules = [], options = {}) => {
  const withTM = (nextConfig = {}) => {
    if (modules.length === 0) return nextConfig;

    const resolveSymlinks = 'resolveSymlinks' in options ? options.resolveSymlinks : true;
    const isWebpack5 = (nextConfig.future && nextConfig.future.webpack5) || false;
    const debug = options.debug || false;

    const logger = createLogger(debug);

    /**
     * Our own Node.js resolver that can ignore symlinks resolution and  can support
     * PnP
     */
    const resolve = enhancedResolve.create.sync({
      symlinks: resolveSymlinks,
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.css', '.scss', '.sass'],
      mainFields: ['main', 'module', 'source'],
      // Is it right? https://github.com/webpack/enhanced-resolve/issues/283#issuecomment-775162497
      conditionNames: ['require'],
      exportsFields: [], // we do that because 'package.json' is usually not present in exports
    });

    /**
     * Deprecated require.resolve
     * @deprecated
     */
    const deprecatedResolve = enhancedResolve.create.sync({
      symlinks: resolveSymlinks,
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.css', '.scss', '.sass'],
      mainFields: ['main', 'module', 'source'],
      // Is it right? https://github.com/webpack/enhanced-resolve/issues/283#issuecomment-775162497
      conditionNames: ['require'],
    });

    /**
     * Deprecated getPackageRootDirectory
     * @deprecated
     */
    const deprecatedGetPackageRootDirectory = (module) => {
      let packageLookupDirectory;
      let packageRootDirectory;

      // Get the module path
      packageLookupDirectory = deprecatedResolve(CWD, module);

      // Get the location of its package.json
      const packageJsonPath = escalade(packageLookupDirectory, (_dir, names) => {
        if (names.includes('package.json')) {
          return 'package.json';
        }
        return false;
      });

      if (packageJsonPath == null) {
        throw new Error(
          `next-transpile-modules - an error happened when trying to get the root directory of "${module}". Is it missing a package.json?\n${err}`
        );
      }
      packageRootDirectory = path.dirname(packageJsonPath);

      return packageRootDirectory;
    };

    /**
     * Return the root path (package.json directory) of a given module
     * @param {string} module
     * @returns {string}
     */
    const getPackageRootDirectory = (module) => {
      let packageLookupDirectory;
      let packageRootDirectory;

      try {
        packageLookupDirectory = resolve(CWD, path.join(module, 'package.json'));
        packageRootDirectory = path.dirname(packageLookupDirectory);
      } catch (err) {
        // DEPRECATED: previous lookup for specific modules, it's confusing, and
        // will be removed in a next major version
        try {
          logger(
            `DEPRECATED - fallbacking to previous module resolution system for module "${module}", you can now just pass the name of the package to transpile and it will detect its real path without you having to pass a sub-module.`,
            true
          );

          packageRootDirectory = deprecatedGetPackageRootDirectory(module);
        } catch (err) {
          throw new Error(
            `next-transpile-modules - an unexpected error happened when trying to resolve "${module}". Are you sure the name module you are trying to transpile is correct, and it has a "main" or an "exports" field?\n${err}`
          );
        }
      }

      return packageRootDirectory;
    };

    logger(`trying to resolve the following modules:\n${modules.map((mod) => `  - ${mod}`).join('\n')}`);

    // Resolve modules to their real paths
    const modulesPaths = modules.map(getPackageRootDirectory);

    logger(`the following paths will get transpiled:\n${modulesPaths.map((mod) => `  - ${mod}`).join('\n')}`);

    // Generate Webpack condition for the passed modules
    // https://webpack.js.org/configuration/module/#ruleinclude
    const matcher = options.__unstable_matcher || createWebpackMatcher(modulesPaths, logger);

    return Object.assign({}, nextConfig, {
      webpack(config, options) {
        // Safecheck for Next < 5.0
        if (!options.defaultLoaders) {
          throw new Error(
            'This plugin is not compatible with Next.js versions below 5.0.0 https://err.sh/next-plugins/upgrade'
          );
        }

        if (resolveSymlinks !== undefined) {
          // Avoid Webpack to resolve transpiled modules path to their real path as
          // we want to test modules from node_modules only. If it was enabled,
          // modules in node_modules installed via symlink would then not be
          // transpiled.
          config.resolve.symlinks = resolveSymlinks;
        }

        const hasInclude = (context, request) => {
          let absolutePath;
          // If we the code requires/import an absolute path
          if (!request.startsWith('.')) {
            try {
              const moduleDirectory = deprecatedGetPackageRootDirectory(request);

              if (!moduleDirectory) return false;

              absolutePath = moduleDirectory;
            } catch (err) {
              return false;
            }
          } else {
            // Otherwise, for relative imports
            absolutePath = path.resolve(context, request);
          }
          return modulesPaths.some((mod) => {
            return absolutePath.startsWith(mod);
          });
        };

        // Since Next.js 8.1.0, config.externals is undefined
        if (config.externals) {
          config.externals = config.externals.map((external) => {
            if (typeof external !== 'function') return external;

            if (isWebpack5) {
              return async (options) => {
                const externalResult = await external(options);
                if (externalResult) {
                  try {
                    const resolve = options.getResolve();
                    const resolved = await resolve(options.context, options.request);
                    if (modulesPaths.some((mod) => resolved.startsWith(mod))) return;
                  } catch (e) {}
                }
                return externalResult;
              };
            }

            return (context, request, cb) => {
              external(context, request, (err, external) => {
                if (err || !external || !hasInclude(context, request)) return cb(err, external);
                cb();
              });
            };
          });
        }

        // Add a rule to include and parse all modules (js & ts)
        if (isWebpack5) {
          config.module.rules.push({
            test: /\.+(js|jsx|mjs|ts|tsx)$/,
            use: options.defaultLoaders.babel,
            include: matcher,
            type: 'javascript/auto',
          });

          if (resolveSymlinks === false) {
            // IMPROVE ME: we are losing all the cache on node_modules, which is terrible
            // The problem is managedPaths does not allow to isolate specific specific folders
            config.snapshot = Object.assign(config.snapshot || {}, {
              managedPaths: [],
            });
          }
        } else {
          config.module.rules.push({
            test: /\.+(js|jsx|mjs|ts|tsx)$/,
            loader: options.defaultLoaders.babel,
            include: matcher,
          });
        }

        // Support CSS modules + global in node_modules
        // TODO ask Next.js maintainer to expose the css-loader via defaultLoaders
        const nextCssLoaders = config.module.rules.find((rule) => typeof rule.oneOf === 'object');

        // .module.css
        if (nextCssLoaders) {
          const nextCssLoader = nextCssLoaders.oneOf.find(
            (rule) => rule.sideEffects === false && regexEqual(rule.test, /\.module\.css$/)
          );

          const nextSassLoader = nextCssLoaders.oneOf.find(
            (rule) => rule.sideEffects === false && regexEqual(rule.test, /\.module\.(scss|sass)$/)
          );

          if (nextCssLoader) {
            nextCssLoader.issuer.or = nextCssLoader.issuer.and ? nextCssLoader.issuer.and.concat(matcher) : matcher;
            delete nextCssLoader.issuer.not;
            delete nextCssLoader.issuer.and;
          } else {
            console.warn('next-transpile-modules - could not find default CSS rule, CSS imports may not work');
          }

          if (nextSassLoader) {
            nextSassLoader.issuer.or = nextSassLoader.issuer.and ? nextSassLoader.issuer.and.concat(matcher) : matcher;
            delete nextSassLoader.issuer.not;
            delete nextSassLoader.issuer.and;
          } else {
            console.warn('next-transpile-modules - could not find default SASS rule, SASS imports may not work');
          }
        }

        if (!isWebpack5) {
          // Make hot reloading work!
          // FIXME: not working on Wepback 5
          // https://github.com/vercel/next.js/issues/13039
          config.watchOptions.ignored = [
            ...config.watchOptions.ignored.filter((pattern) => pattern !== '**/node_modules/**'),
            `**node_modules/{${modules.map((mod) => `!(${mod})`).join(',')}}/**/*`,
          ];
        }

        // Overload the Webpack config if it was already overloaded
        if (typeof nextConfig.webpack === 'function') {
          return nextConfig.webpack(config, options);
        }

        return config;
      },
    });
  };

  return withTM;
};

module.exports = withTmInitializer;
