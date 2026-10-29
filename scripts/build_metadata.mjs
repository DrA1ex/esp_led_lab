// Optional regeneration: npm ci --prefix scripts/metadata --ignore-scripts
// then node scripts/build_metadata.mjs. Normal WASM/standalone builds use the
// checked-in browser bundle and need neither npm nor an internet connection.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
const require=createRequire(new URL('./metadata/package.json',import.meta.url));
const {build}=require('esbuild');
const licenses=readFileSync(new URL('../web/vendor/THIRD_PARTY_LICENSES.txt',import.meta.url),'utf8').replaceAll('*/','* /');
await build({banner:{js:'/*! Third-party licenses\n'+licenses+'\n*/'},entryPoints:[fileURLToPath(new URL('./metadata/entry.js',import.meta.url))],bundle:true,format:'iife',platform:'browser',globalName:'AudioMetadata',minify:true,legalComments:'inline',outfile:fileURLToPath(new URL('../web/vendor/audio-metadata.js',import.meta.url))});
