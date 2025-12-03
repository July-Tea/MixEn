#!/usr/bin/env node
const esbuild = require('esbuild');
const fs = require('fs');

const args = process.argv.slice(2);
const isDev = args.includes('--dev');

const banner = '/* Built by esbuild. */';
const common = {
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  legalComments: 'none',
  logLevel: 'info',
  banner: { js: banner },
  minify: !isDev,
  drop: isDev ? [] : ['console','debugger'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production')
  }
};

esbuild.build({
  entryPoints: ['src/content.ts'],
  outfile: 'extension/content.js',
  ...common
}).then(()=> esbuild.build({
  entryPoints: ['src/options.ts'],
  outfile: 'extension/options.js',
  ...common
})).catch((e)=>{ console.error(e); process.exit(1); });

// ensure css copied (already referenced directly)
if(!fs.existsSync('extension/styles/tooltip.css')){
  console.warn('Missing tooltip.css');
}
