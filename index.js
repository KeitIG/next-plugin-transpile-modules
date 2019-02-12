const path = require('path');

/**
 * Stolen from https://stackoverflow.com/questions/10776600/testing-for-equality-of-regular-expressions
 */
function regexEqual (x, y) {
  return (x instanceof RegExp) && (y instanceof RegExp) &&
    (x.source === y.source) && (x.global === y.global) &&
    (x.ignoreCase === y.ignoreCase) && (x.multiline === y.multiline);
}

/**
 * Actual Next.js plugin
 */
module.exports = (nextConfig = {}) => {
  const { transpileModules = [] } = nextConfig;
  const includes = transpileModules.map(module => (new RegExp(`${module}(?!.*node_modules)`)));
  const excludes = [new RegExp(`node_modules(?!/(${transpileModules.join('|')})(?!.*node_modules))`)];

  return Object.assign({}, nextConfig, {
    webpack (config, options) {
      // Safecheck for Next < 5.0
      if (!options.defaultLoaders) {
        throw new Error(
          'This plugin is not compatible with Next.js versions below 5.0.0 https://err.sh/next-plugins/upgrade'
        );
      }

      // Avoid Webpack to resolve transpiled modules path to their real path
      config.resolve.symlinks = false;

      config.externals = config.externals.map(external => {
        if (typeof external !== 'function') return external;
        return (ctx, req, cb) => {
          return includes.find(include =>
            req.startsWith('.')
              ? include.test(path.resolve(ctx, req))
              : include.test(req)
          )
            ? cb()
            : external(ctx, req, cb);
        };
      });

      // Add a rule to include and parse all modules
      config.module.rules.push({
        test: /\.+(js|jsx|ts|tsx)$/,
        loader: options.defaultLoaders.babel,
        include: includes
      });

      if (typeof nextConfig.webpack === 'function') {
        return nextConfig.webpack(config, options);
      }

      return config;
    },

    // webpackDevMiddleware needs to be told to watch the changes in the
    // transpiled modules directories
    webpackDevMiddleware (config) {
      // Replace /node_modules/ by the new exclude RegExp (including the modules
      // that are going to be transpiled)
      const ignored = config.watchOptions.ignored.filter(
        regexp => !regexEqual(regexp, /[\\/]node_modules[\\/]/)
      ).concat(excludes);

      config.watchOptions.ignored = ignored;
      return config;
    }
  });
};
