// Pipeline : bundle serveur (esbuild) + copie web/dist + electron-builder -> ../dist-desktop
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { makeIco } from './make-icon.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = join(here, 'build');
const dist = join(root, 'dist-desktop');

// Caches DANS le workspace (confinement DSH : pas d'ecriture hors workspace).
process.env.ELECTRON_CACHE ??= join(here, '.cache', 'electron');
process.env.ELECTRON_BUILDER_CACHE ??= join(here, '.cache', 'builder');
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const tmp = join(here, '.cache', 'tmp'); // makensis ecrit dans TEMP
mkdirSync(tmp, { recursive: true });
process.env.TEMP = tmp; process.env.TMP = tmp;
for (const d of [process.env.ELECTRON_CACHE, process.env.ELECTRON_BUILDER_CACHE]) mkdirSync(d, { recursive: true });

const webDist = join(root, 'web', 'dist');
if (!existsSync(join(webDist, 'index.html'))) throw new Error('web/dist absent : lancer le build web d abord');

mkdirSync(join(here, 'assets'), { recursive: true });
if (!existsSync(join(here, 'assets', 'icon.ico'))) writeFileSync(join(here, 'assets', 'icon.ico'), makeIco());

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(here, 'server-entry.mjs')],
  outfile: join(out, 'server.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['node:*'],
  nodePaths: [join(root, 'server', 'node_modules')],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  // Depot GitHub des mises a jour : GITHUB_REPOSITORY en CI (owner/repo), FORGET_UPDATE_REPO en local.
  define: { __FORGET_UPDATE_REPO__: JSON.stringify(process.env.FORGET_UPDATE_REPO || process.env.GITHUB_REPOSITORY || '') },
  logLevel: 'info',
});
cpSync(webDist, join(out, 'web'), { recursive: true });

rmSync(dist, { recursive: true, force: true });
const config = {
  appId: 'dev.forget.local',
  productName: 'Forget',
  asar: true,
  directories: { app: here, output: dist },
  files: ['main.js', 'social-windows.js', 'tiktok-window.js', 'oauth-window.js', 'preload.js', 'splash.html', 'package.json', 'assets/icon.ico', 'build/**/*'],
  publish: null,
  // Durcissement Electron (fuses) : l'executable ne peut pas servir d'interpreteur Node, ignore NODE_OPTIONS et
  // --inspect, ne charge l'application que depuis app.asar et verifie l'integrite de cette archive.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
    grantFileProtocolExtraPrivileges: false,
    enableCookieEncryption: true,
  },
  // Un seul fichier : executable portable (s'extrait en dossier temporaire au lancement, rien n'est installe).
  win: { target: [{ target: 'portable', arch: ['x64'] }], icon: 'assets/icon.ico', signAndEditExecutable: false },
  portable: {
    artifactName: 'Forget-${version}.${ext}', // nom stable attendu par le bouton « Mettre a jour »
  },
};
const cfgPath = join(here, '.builder.generated.json');
writeFileSync(cfgPath, JSON.stringify(config, null, 2));

const bin = join(here, 'node_modules', 'electron-builder', 'cli.js');
const r = spawnSync(process.execPath, [bin, '--win', '--x64', '--config', cfgPath, '--publish', 'never'], {
  cwd: here, stdio: 'inherit', env: process.env,
});
if (r.status !== 0) { console.error('electron-builder a echoue'); process.exit(r.status || 1); }
// Livrable unique : on ne garde que Forget-<version>.exe (FORGET_KEEP_UNPACKED=1 conserve win-unpacked pour verify.mjs).
if (process.env.FORGET_KEEP_UNPACKED !== '1') {
  for (const extra of ['win-unpacked', 'builder-debug.yml', 'builder-effective-config.yaml']) rmSync(join(dist, extra), { recursive: true, force: true });
}
console.log('OK ->', dist);
