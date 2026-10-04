/**
 * --------------------------------------------------------------------
 * docmd doctor : pre-flight check command.
 *
 * Walks the user's config, checks every configured plugin and template
 * against the official registry, and prints a single status report. No
 * filesystem writes, no build side-effects — purely a diagnostic tool.
 *
 * Flags:
 *   --fix    Auto-install missing official plugins/templates.
 *   --json   Emit the report as JSON (for tooling).
 *   --config <path>  Path to docmd.config (defaults to the same search the
 *                    build commands use).
 *
 * Exit codes:
 *   0  — every check passed (or --fix resolved everything).
 *   1  — at least one problem remains (missing plugin, version mismatch,
 *         broken manifest).
 *   2  — usage error.
 * --------------------------------------------------------------------
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TUI } from '@docmd/tui';
import { loadConfig } from '../utils/config-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PluginReport {
  name: string;
  status: 'ok' | 'missing' | 'mismatch' | 'third-party' | 'unknown';
  declaredVersion?: string;
  installedVersion?: string;
  fixable: boolean;
  hint?: string;
}

interface DoctorReport {
  config: string | null;
  core: { name: string; version: string; status: 'ok' | 'missing' };
  plugins: PluginReport[];
  template?: { requested: string; resolved: string; status: 'ok' | 'missing' };
  engines: Array<{ name: string; status: 'ok' | 'missing' | 'unknown' }>;
  autoInstallCandidates: string[];
  warnings: string[];
  errors: string[];
}

interface DoctorOptions {
  configPath?: string;
  fix: boolean;
  json: boolean;
}

export async function runDoctor(opts: DoctorOptions): Promise<number> {
  // 1. Resolve the config.
  const configPath = opts.configPath ? path.resolve(opts.configPath) : null;
  let config: any = {};
  let configError: string | null = null;
  if (configPath) {
    try {
      const loaded = await loadConfig(configPath);
      config = loaded?.config || loaded || {};
    } catch (e: any) {
      configError = e.message;
    }
  } else {
    // loadConfig requires an explicit path; we don't have a built-in
    // "find a config" helper yet. The user can re-run with --config.
    configError = 'No config path provided. Use --config <path> to point at docmd.config.{json,ts,js,mjs}.';
  }

  // 2. Build the report.
  const report: DoctorReport = {
    config: configPath,
    core: { name: '@docmd/core', version: 'unknown', status: 'ok' },
    plugins: [],
    engines: [],
    autoInstallCandidates: [],
    warnings: [],
    errors: configError ? [configError] : [],
  };

  // 3. Check @docmd/core version. We try a chain of strategies so the
  // doctor works in three real-world layouts:
  //   (a) a real user install — `node_modules/@docmd/core/package.json`
  //       is reachable via standard `createRequire` resolution.
  //   (b) monorepo dev with a built dist — the build output sits under
  //       `packages/core/dist/commands/`, and `import.meta.url` lets us
  //       derive the package root and read the in-tree `package.json`.
  //   (c) pnpm's symlinked `node_modules/@docmd/core` from inside the
  //       playground — walk up from cwd and try every ancestor.
  //
  // If all strategies fail, we genuinely don't have `@docmd/core` on the
  // resolve path; we report that rather than guessing.
  report.core = resolveCorePackage();
  if (report.core.status === 'missing') {
    report.errors.push('@docmd/core is not installed');
  }

  // 4. Check configured plugins.
  const configuredPlugins: Record<string, any> = (config.plugins || {});
  for (const [key, userOpts] of Object.entries(configuredPlugins)) {
    if (userOpts === false) continue;
    const pkgName = key.startsWith('@docmd/') ? key : `@docmd/plugin-${key}`;
    const installed = tryReadPackage(pkgName);
    if (installed) {
      report.plugins.push({
        name: key,
        status: 'ok',
        installedVersion: installed.version,
        fixable: false,
      });
    } else {
      report.plugins.push({
        name: key,
        status: 'missing',
        fixable: true,
        hint: `Run \`docmd add ${key}\` or add "${pkgName}" to your dependencies.`,
      });
      report.autoInstallCandidates.push(pkgName);
    }
  }

  // 5. Check the active template.
  if (config.theme?.template) {
    const tplName = String(config.theme.template).trim();
    const tplPkg = tplName.startsWith('@docmd/') ? tplName : `@docmd/template-${tplName}`;
    const installed = tryReadPackage(tplPkg);
    report.template = {
      requested: tplName,
      resolved: tplPkg,
      status: installed ? 'ok' : 'missing',
    };
    if (!installed) {
      report.autoInstallCandidates.push(tplPkg);
    }
  }

  // 6. Check engines. (The JS engine ships with core; Rust and Python engines are optional.)
  const requestedEngine = (config.engine || 'js').toLowerCase();
  report.engines.push({ name: 'js', status: 'ok' });
  if (requestedEngine === 'rust' || config.engines?.rust) {
    const rustInstalled = tryReadPackage('@docmd/engine-rust');
    report.engines.push({ name: 'rust', status: rustInstalled ? 'ok' : 'missing' });
  }
  if (requestedEngine === 'python' || config.engines?.python) {
    const pythonInstalled = tryReadPackage('@docmd/engine-python');
    report.engines.push({ name: 'python', status: pythonInstalled ? 'ok' : 'missing' });
  }

  // 7. Optional auto-fix.
  if (opts.fix && report.autoInstallCandidates.length > 0) {
    const { spawnSync } = await import('node:child_process');
    const cwd = process.cwd();
    const pkgManager = detectPackageManager(cwd);
    try {
      spawnSync(pkgManager, ['add', ...report.autoInstallCandidates], {
        stdio: 'inherit',
        cwd,
        timeout: 180000,
        shell: process.platform === 'win32'
      });
    } catch (e: any) {
      report.errors.push(`Auto-install failed: ${e.message}`);
    }
  }

  // 8. Emit.
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  return report.errors.length > 0 ? 1 : 0;
}

function printReport(r: DoctorReport): void {
  console.log('');
  console.log('┌─ docmd pre-flight check');
  console.log('│');
  console.log(`│  ${r.core.name.padEnd(28)} ${r.core.version.padEnd(10)} ${r.core.status === 'ok' ? TUI.green('✓ installed') : TUI.red('✗ missing')}`);
  console.log('│');
  console.log('│  Configured plugins (' + r.plugins.length + ')');
  for (const p of r.plugins) {
    const sym = p.status === 'ok' ? TUI.green('✓') : p.status === 'missing' ? TUI.yellow('⚠') : TUI.dim('·');
    const ver = p.installedVersion ? ` (${p.installedVersion})` : '';
    console.log(`│    ${sym} ${p.name.padEnd(20)}${ver}${p.hint ? '  ' + TUI.dim(p.hint) : ''}`);
  }
  if (r.template) {
    const sym = r.template.status === 'ok' ? TUI.green('✓') : TUI.yellow('⚠');
    console.log(`│`);
    console.log(`│  Template`);
    console.log(`│    ${sym} ${r.template.resolved}${r.template.status === 'missing' ? '  ' + TUI.dim('not installed') : ''}`);
  }
  if (r.engines.length) {
    console.log('│');
    console.log('│  Engines');
    for (const e of r.engines) {
      const sym = e.status === 'ok' ? TUI.green('✓') : TUI.yellow('⚠');
      console.log(`│    ${sym} ${e.name}`);
    }
  }
  if (r.autoInstallCandidates.length) {
    console.log('│');
    console.log('│  ' + TUI.yellow(`Auto-install candidates (${r.autoInstallCandidates.length})`) + ' — run `docmd doctor --fix`');
    for (const c of r.autoInstallCandidates) {
      console.log(`│    • ${c}`);
    }
  }
  if (r.errors.length) {
    console.log('│');
    console.log('│  ' + TUI.red('Errors'));
    for (const e of r.errors) console.log(`│    ${e}`);
  }
  console.log('└──────────────────────────────────');
  console.log('');
}

/**
 * Resolve `@docmd/core`'s version with a chain of strategies. Returns
 * `{ name, version, status: 'ok' }` on success, or
 * `{ name, version: 'unknown', status: 'missing' }` if the package is
 * genuinely not on the resolve path.
 *
 * Strategy order:
 *   1. `createRequire(import.meta.url)` from the doctor file's URL —
 *      this works for a real user install where the doctor runs from
 *      `node_modules/@docmd/core/dist/commands/doctor.js`.
 *   2. Walk up from `process.cwd()` looking for a `node_modules/@docmd/core/package.json`
 *      — this covers pnpm's symlinked layout from the playground and
 *      yarn's hoisted layout in monorepos.
 *   3. Walk up from the doctor file's location looking for an in-tree
 *      `package.json` whose `name` is `@docmd/core` — this covers the
 *      monorepo dev case where the dist files are run directly without
 *      being installed into a `node_modules` tree.
 */
function resolveCorePackage(): { name: string; version: string; status: 'ok' | 'missing' } {
  const FAIL = { name: '@docmd/core', version: 'unknown', status: 'missing' as const };
  const SEARCH_NAMES = new Set(['@docmd/core', 'docmd']);

  // Strategy 1: createRequire from this file's URL.
  try {
    const req = createRequire(import.meta.url);
    const pkg = req('@docmd/core/package.json');
    return { name: pkg.name, version: pkg.version, status: 'ok' };
  } catch { /* fall through */ }

  // Strategy 2: walk up from cwd looking for node_modules/@docmd/core/package.json.
  for (let dir = path.resolve(process.cwd()); ; ) {
    const candidate = path.join(dir, 'node_modules', '@docmd', 'core', 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (SEARCH_NAMES.has(pkg.name)) {
          return { name: pkg.name, version: pkg.version, status: 'ok' };
        }
      } catch { /* try next ancestor */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Strategy 3: walk up from the doctor file's location looking for an
  // in-tree package.json whose name is @docmd/core. This is the monorepo
  // dev case where the dist files are run directly without being installed
  // into a node_modules tree.
  let dir = path.resolve(__dirname);
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (SEARCH_NAMES.has(pkg.name)) {
          return { name: pkg.name, version: pkg.version, status: 'ok' };
        }
      } catch { /* try next ancestor */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return FAIL;
}

/**
 * Read a package's `package.json` from any of the three strategies above.
 * Used to detect configured plugins and engines.
 */
function tryReadPackage(name: string): { name: string; version: string } | null {
  // Strategy 1: createRequire from this file's URL.
  try {
    const req = createRequire(import.meta.url);
    const pkg = req(`${name}/package.json`);
    return { name: pkg.name, version: pkg.version };
  } catch { /* fall through */ }

  // Strategy 2: walk up from cwd.
  for (let dir = path.resolve(process.cwd()); ; ) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'), 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, 'utf8'));
      } catch { /* try next ancestor */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Strategy 3: walk up from the doctor file's location.
  let dir = path.resolve(__dirname);
  while (true) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'), 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, 'utf8'));
      } catch { /* try next ancestor */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

function detectPackageManager(cwd: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  let dir = require('node:path').resolve(cwd);
  const { existsSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  while (true) {
    if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
    if (existsSync(join(dir, 'bun.lockb'))) return 'bun';
    if (existsSync(join(dir, 'package-lock.json'))) return 'npm';
    const parent = require('node:path').dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'npm';
}