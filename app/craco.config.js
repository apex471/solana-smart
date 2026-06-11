const webpack = require("webpack");

module.exports = {
  webpack: {
    configure: (config) => {
      config.resolve.fallback = {
        crypto:  require.resolve("crypto-browserify"),
        stream:  require.resolve("stream-browserify"),
        assert:  require.resolve("assert"),
        buffer:  require.resolve("buffer"),
        process: require.resolve("process/browser.js"),
        vm:      false,
        path:    false,
        os:      false,
        fs:      false,
        net:     false,
        tls:     false,
      };

      config.plugins.push(
        new webpack.ProvidePlugin({
          process: "process/browser.js",
          Buffer:  ["buffer", "Buffer"],
        })
      );

      config.ignoreWarnings = [/Failed to parse source map/];

      return config;
    },
  },
};
