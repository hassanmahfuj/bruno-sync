#!/usr/bin/env node
import { existsSync } from 'fs';
import { join, basename, resolve } from 'path';
import { execFileSync } from 'child_process';
import { parseArgs } from 'util';
import { isUrl, loadSpec, listGroups, prepareSpec, defaultBaseUrl } from './src/spec.mjs';
import { buildFiles } from './src/generate.mjs';
import { planUpdate, applyUpdate, readManifest, writeManifest } from './src/sync.mjs';
import { writeOpenCollectionYml, findWorkspace, workspaceCollections, registerInWorkspace } from './src/collection.mjs';

const usage = `usage: ./bruno-sync.mjs <command>

commands:
  groups <url>                 list Springfox swagger groups at a service URL
  list                         list synced collections in the Bruno workspace
  create <source> [dir]        create a collection from a spec URL or file
  create <url> [dir] --all-groups
                               create one collection per group, inside dir
  link <dir> <source>          connect an existing collection to a spec
  status <dir> | --all         preview an update, writes nothing
  update <dir> | --all         sync a collection with its spec

flags:
  --group <name>               swagger group, for create and link
  --name <name>                collection name, for create
  --auth-from <dir>            copy auth from another collection, for create
  --base-url <url>             value of the baseUrl variable, for create
  --prune                      delete orphaned requests you never edited
  --dry-run                    preview only, same as status
  --force                      write even while Bruno is running

<dir> is a path, or the name of a collection in the Bruno workspace.
new collections go in the current folder unless you give a path.`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    group: { type: 'string' },
    name: { type: 'string' },
    'auth-from': { type: 'string' },
    'base-url': { type: 'string' },
    'all-groups': { type: 'boolean' },
    all: { type: 'boolean' },
    prune: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
const [command, ...commandArgs] = positionals;

const workspaceYml = findWorkspace();
const collections = workspaceCollections(workspaceYml);

const absoluteSource = source => (isUrl(source) ? source : resolve(source));
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function collectionPath(dir) {
  const known = collections.find(({ name, path }) => name === dir || basename(path) === dir);
  return known?.path ?? resolve(dir);
}

function syncedCollections() {
  return collections.map(({ path }) => path).filter(path => readManifest(path)?.source);
}

function brunoRunning() {
  try {
    execFileSync('pgrep', ['-x', 'bruno'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const watchedByBruno = dir => collections.some(({ path }) => path === dir);

function refuseWhileBrunoOpen(paths) {
  if (flags.force || !brunoRunning()) return;
  if (paths.some(watchedByBruno)) throw new Error('Bruno is running and uses this collection. Quit it first, or pass --force.');
}

async function fetchFiles(source, group) {
  const spec = await loadSpec(source, group);
  const missing = prepareSpec(spec);
  if (missing.length) console.log(`patched ${missing.length} missing schema(s): ${missing.join(', ')}`);
  return { spec, fresh: await buildFiles(spec) };
}

function report(label, plan) {
  console.log(`[${label}] ${plan.unchanged.length} unchanged, ${plan.updated.length} updated, ${plan.adds.length} new, ${plan.skips.length} skipped (edited)`);
  if (plan.adoption) console.log('  first sync: comparing existing files with the spec');
  for (const path of plan.adds) console.log(`  new: ${path}`);
  for (const path of plan.updated) console.log(`  updated: ${path}`);
  for (const { from, to } of plan.renames) console.log(`  renamed: ${from} -> ${to}`);
  for (const path of plan.skips) console.log(`  skipped: ${path}`);
  for (const path of plan.orphans) console.log(`  orphan: ${path}`);
  for (const path of plan.orphanEdited) console.log(`  orphan, edited: ${path}`);
}

async function create(source, dirArg, group) {
  const { spec, fresh } = await fetchFiles(source, group);
  const name = flags.name ?? group ?? fresh.title ?? 'collection';
  const dir = collectionPath(dirArg ?? slug(name));
  if (existsSync(join(dir, 'opencollection.yml'))) throw new Error(`${dir} already exists. Use update.`);
  if (brunoRunning() && workspaceYml && !flags.force) {
    throw new Error('Bruno is running and its workspace would change. Quit it first, or pass --force.');
  }

  writeOpenCollectionYml(dir, {
    name,
    baseUrl: flags['base-url'] ?? defaultBaseUrl(source, spec, group),
    authFrom: flags['auth-from'] && collectionPath(flags['auth-from']),
  });
  applyUpdate(dir, fresh, planUpdate(dir, fresh), { source, group });

  console.log(`created ${dir} (${fresh.keys.size} requests)`);
  if (registerInWorkspace(workspaceYml, { name, path: dir })) console.log('added to the Bruno workspace');
}

async function sync(dir, { dryRun }) {
  const manifest = readManifest(dir);
  if (!manifest?.source) throw new Error(`${dir} has no saved source. Run: link "${dir}" <source>`);
  if (!dryRun) refuseWhileBrunoOpen([dir]);

  const { fresh } = await fetchFiles(manifest.source, manifest.group);
  const plan = planUpdate(dir, fresh);
  report(dir.split('/').pop(), plan);
  if (!dryRun) applyUpdate(dir, fresh, plan, { prune: flags.prune, source: manifest.source, group: manifest.group });
}

function link(dirArg, source) {
  const dir = collectionPath(dirArg);
  if (!existsSync(join(dir, 'opencollection.yml'))) throw new Error(`no collection at ${dir}`);
  const manifest = readManifest(dir) ?? {};
  const { group, ...rest } = manifest;
  writeManifest(dir, { ...rest, source, ...(flags.group ? { group: flags.group } : {}) });
  console.log(`linked ${dir} to ${source}${flags.group ? ` (group: ${flags.group})` : ''}`);
}

async function main() {
  if (!command || command === 'help' || flags.help) return console.log(usage);

  if (command === 'groups') {
    for (const group of await listGroups(commandArgs[0])) console.log(group.name);
    return;
  }

  if (command === 'list') {
    for (const dir of syncedCollections()) {
      const { source, group, syncedAt } = readManifest(dir);
      console.log(`${dir.split('/').pop()}\n  source: ${source}${group ? `\n  group:  ${group}` : ''}\n  synced: ${syncedAt ?? 'never'}`);
    }
    return;
  }

  if (command === 'create') {
    const [sourceArg, dir] = commandArgs;
    if (!sourceArg) throw new Error(usage);
    const source = absoluteSource(sourceArg);
    if (flags['all-groups']) {
      for (const group of await listGroups(source)) await create(source, join(dir ?? '.', slug(group.name)), group.name);
    } else {
      await create(source, dir, flags.group);
    }
    return;
  }

  if (command === 'link') {
    const [dir, source] = commandArgs;
    if (!dir || !source) throw new Error(usage);
    return link(dir, absoluteSource(source));
  }

  if (command === 'status' || command === 'update') {
    const dryRun = command === 'status' || flags['dry-run'];
    const targets = flags.all ? syncedCollections() : commandArgs.slice(0, 1).map(collectionPath);
    if (!targets.length) throw new Error(usage);
    for (const dir of targets) await sync(dir, { dryRun });
    return;
  }

  throw new Error(`unknown command: ${command}\n\n${usage}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
