/**
 * Transforms the check bundle with babel-preset-expo exactly as Metro does
 * for a production iOS build (Hermes engine), so run.sh can also execute the
 * result as Hermes BYTECODE (hermesc -O), the form the shipped app runs.
 * Usage: node babelize.cjs <in.js> <out.js>   (cwd = apps/mobile)
 */
const babel = require(require.resolve('@babel/core', { paths: [process.cwd()] }));
const fs = require('fs');
const [input, output] = process.argv.slice(2);
const res = babel.transformSync(fs.readFileSync(input, 'utf8'), {
  filename: 'bundle.js', babelrc: false, configFile: false, sourceType: 'script',
  presets: [[require.resolve('babel-preset-expo', { paths: [process.cwd()] }), {}]],
  caller: { name: 'metro', bundler: 'metro', platform: 'ios', isDev: false, isServer: false, engine: 'hermes' },
});
fs.writeFileSync(output, res.code);
