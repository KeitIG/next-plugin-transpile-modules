const path = require('path');

const PATH_DELIMITER = '[\\\\/]'; // match 2 antislashes or one slash

/**
 * Stolen from https://stackoverflow.com/questions/10776600/testing-for-equality-of-regular-expressions
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

const generateIncludes = (modules) => {
  return [
    new RegExp(`(${modules.map(safePath).join('|')})$`),
    new RegExp(`(${modules.map(safePath).join('|')})${PATH_DELIMITER}(?!.*node_modules)`)
  ];
};

const generateExcludes = (modules) => {
  return [
    new RegExp(
      `node_modules${PATH_DELIMITER}(?!(${modules.map(safePath).join('|')})(${PATH_DELIMITER}|$)(?!.*node_modules))`
    )
  ];
};

/**
 * On Windows, the Regex won't match as Webpack tries to resolve the
 * paths of the modules. So we need to check for \\ and /
 */
const safePath = (module) => module.split('/').join(PATH_DELIMITER);

/**
 * Actual Next.js plugin
 */
const withTmInitializer = (transpileModules = []) => {
  const withTM = (nextConfig = {}) => {
    if (transpileModules.length === 0) return nextConfig;

    const includes = generateIncludes(transpileModules);
    const excludes = generateExcludes(transpileModules);

    return Object.assign({}, nextConfig, {
      webpack(config, options) {
        // Safecheck for Next < 5.0
        if (!options.defaultLoaders) {
          throw new Error(
            'This plugin is not compatible with Next.js versions below 5.0.0 https://err.sh/next-plugins/upgrade'
          );
        }

        // Avoid Webpack to resolve transpiled modules path to their real path as
        // we want to test modules from node_modules only. If it was enabled,
        // modules in node_modules installed via symlink would then not be
        // transpiled.
        config.resolve.symlinks = false;

        // Since Next.js 8.1.0, config.externals is undefined
        if (config.externals) {
          config.externals = config.externals.map((external) => {
            if (typeof external !== 'function') return external;
            return (ctx, req, cb) => {
              return includes.find((include) =>
                req.startsWith('.') ? include.test(path.resolve(ctx, req)) : include.test(req)
              )
                ? cb()
                : external(ctx, req, cb);
            };
          });
        }

        // Add a rule to include and parse all modules (js & ts)
        config.module.rules.push({
          test: /\.+(js|jsx|ts|tsx)$/,
          loader: options.defaultLoaders.babel,
          include: includes
        });

        // Support CSS modules + global in node_modules
        // TODO ask Next.js maintainer to expose the css-loader via defaultLoaders
        const nextCssLoaders = config.module.rules.find((rule) => typeof rule.oneOf === 'object');

        // .module.css and .module.sass/.module.scss
        if (nextCssLoaders) {
          const nextCssLoader = nextCssLoaders.oneOf.find(
            (rule) => rule.sideEffects === false && regexEqual(rule.test, /\.module\.css$/)
          );
          if (nextCssLoader) {
            nextCssLoader.issuer.include = nextCssLoader.issuer.include.concat(includes);
            nextCssLoader.issuer.exclude = excludes;
          }

          const nextSassLoader = nextCssLoaders.oneOf.find(
            (rule) => rule.sideEffects === false && regexEqual(rule.test, /\.module\.(scss|sass)$/)
          );

          if (nextSassLoader) {
            nextSassLoader.issuer.include = nextSassLoader.issuer.include.concat(includes);
            nextSassLoader.issuer.exclude = excludes;
          }

          // Hack our way to disable errors on node_modules CSS modules
          const nextErrorCssLoader = nextCssLoaders.oneOf.find(
            (rule) => rule.use && rule.use.loader === 'error-loader' && (Array.isArray(rule.test) ? regexEqual(rule.test[0], /\.module\.css$/) : regexEqual(rule.test, /\.module\.css$/))
          );

          if (nextErrorCssLoader) {
            nextErrorCssLoader.exclude = includes;
          }

          // Overload the Webpack config if it was already overloaded
          if (typeof nextConfig.webpack === 'function') {
            return nextConfig.webpack(config, options);
          }

        }

        return config;
      },

      // webpackDevMiddleware needs to be told to watch the changes in the
      // transpiled modules directories
      webpackDevMiddleware(config) {
        // Replace /node_modules/ by the new exclude RegExp (including the modules
        // that are going to be transpiled)
        // https://github.com/zeit/next.js/blob/815f2e91386a0cd046c63cbec06e4666cff85971/packages/next/server/hot-reloader.js#L335
        const ignored = config.watchOptions.ignored
          .filter((regexp) => !regexEqual(regexp, /[\\/]node_modules[\\/]/))
          .concat(excludes);

        config.watchOptions.ignored = ignored;

        if (typeof nextConfig.webpackDevMiddleware === 'function') {
          return nextConfig.webpackDevMiddleware(config);
        }

        return config;
      }
    });
  };

  return withTM;
};

module.exports = withTmInitializer;
