// webpack.config.js — bundle the TypeScript sources to a single .gs
// file via gas-webpack-plugin. The plugin walks the bundle for any
// function tagged with the @customfunction-style root export (we use
// `global.fnName = fnName` in src/entry.ts) and emits them as
// top-level Apps Script functions so triggers / clasp can pick them
// up.
//
// We also copy `appsscript.json` (the Apps Script manifest) into the
// build/ output so `clasp push` finds it.

const path = require("path");
const GasPlugin = require("gas-webpack-plugin");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = (_env, argv) => {
  const isProd = (argv && argv.mode) === "production";
  return {
    mode: isProd ? "production" : "development",
    devtool: false,
    entry: path.resolve(__dirname, "src/entry.ts"),
    output: {
      filename: "Code.js",
      path: path.resolve(__dirname, "build"),
      libraryTarget: "this",
    },
    resolve: {
      extensions: [".ts", ".js"],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          loader: "ts-loader",
          exclude: /node_modules/,
          options: { transpileOnly: true },
        },
      ],
    },
    plugins: [
      // gas-webpack-plugin rewrites the bundle so each `exports.fn` in
      // the entry module becomes a top-level Apps Script function +
      // gets re-assigned to webpack's runtime global. The
      // `autoGlobalExportsFiles` glob is the set of files whose ES
      // module exports should be lifted; ours is just entry.ts.
      new GasPlugin({
        comment: false,
        autoGlobalExportsFiles: ["src/entry.ts"],
      }),
      // Copy the manifest (appsscript.json) into build/. clasp push
      // expects it at the project root.
      new CopyPlugin({
        patterns: [
          { from: path.resolve(__dirname, "appsscript.json"), to: "appsscript.json" },
        ],
      }),
    ],
    optimization: {
      // Apps Script V8 runtime understands ES2019. Don't mangle
      // identifiers — debugging in the Apps Script editor relies on
      // readable names.
      minimize: false,
    },
    performance: { hints: false },
  };
};
