import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import yaml from 'js-yaml';
import { sha } from './generate.mjs';

const MANIFEST = '.bruno-sync.json';
const NOT_REQUEST_FILES = new Set(['folder.yml', 'opencollection.yml']);
const NO_SPEC_MATCH = ' (no matching spec operation)';

export function readManifest(dir) {
  const path = join(dir, MANIFEST);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

export function writeManifest(dir, manifest) {
  writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
}

function scanRequests(dir) {
  const requests = new Map();
  const walk = (current, rel) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (path !== 'environments') walk(join(current, entry.name), path);
      } else if (entry.name.endsWith('.yml') && !NOT_REQUEST_FILES.has(entry.name)) {
        requests.set(path, readFileSync(join(current, entry.name), 'utf8'));
      }
    }
  };
  walk(dir, '');
  return requests;
}

const requestKey = (path, request) => {
  const dir = dirname(path) === '.' ? '' : dirname(path);
  const url = (request.http?.url ?? '').replace(/^\{\{baseUrl\}\}/, '');
  return `${dir}::${request.http?.method} ${url}`;
};

const withoutSeq = text => {
  const request = yaml.load(text);
  delete request.info?.seq;
  return JSON.stringify(request);
};

const sameExceptSeq = (a, b) => withoutSeq(a) === withoutSeq(b);

export function planUpdate(dir, fresh) {
  const stored = readManifest(dir);
  const manifest = stored?.files ? stored : null;
  const disk = scanRequests(dir);

  const diskPathByKey = new Map();
  if (!manifest) {
    for (const [path, text] of disk) {
      try {
        diskPathByKey.set(requestKey(path, yaml.load(text)), path);
      } catch {
        // an unparsable file has no key, so it is reported below and left alone
      }
    }
  }

  const plan = {
    updated: [],
    unchanged: [],
    adds: [],
    skips: [],
    renames: [],
    orphans: [],
    orphanEdited: [],
    folders: [...fresh.files.keys()].filter(path => path.endsWith('folder.yml')),
    previous: manifest,
    adoption: !manifest,
    writes: new Map(),
    keptHashes: new Map(),
  };
  const claimed = new Set();

  const keepOnDisk = (path, text) => {
    plan.keptHashes.set(path, sha(text));
    plan.unchanged.push(path);
  };

  for (const [key, newPath] of fresh.keys) {
    const oldPath = manifest ? manifest.keys[key] : diskPathByKey.get(key);
    const sourcePath = oldPath ?? newPath;
    claimed.add(sourcePath);
    if (oldPath && oldPath !== newPath) plan.renames.push({ from: oldPath, to: newPath });

    const diskText = disk.get(sourcePath);
    const freshText = fresh.files.get(newPath);
    if (diskText === undefined) {
      plan.adds.push(newPath);
      plan.writes.set(newPath, freshText);
      continue;
    }

    const untouched = manifest ? manifest.files[sourcePath] === sha(diskText) : sameExceptSeq(diskText, freshText);
    if (!untouched) {
      plan.skips.push(sourcePath);
    } else if (sourcePath === newPath && sameExceptSeq(diskText, freshText)) {
      keepOnDisk(newPath, diskText);
    } else {
      plan.writes.set(newPath, freshText);
      plan.updated.push(newPath);
    }
  }

  for (const [path, text] of disk) {
    if (claimed.has(path)) continue;
    if (!manifest) plan.skips.push(path + NO_SPEC_MATCH);
    else if (manifest.files[path] === sha(text)) plan.orphans.push(path);
    else plan.orphanEdited.push(path);
  }

  return plan;
}

export function applyUpdate(dir, fresh, plan, { prune, source, group }) {
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };

  for (const path of plan.folders) write(path, fresh.files.get(path));
  for (const [path, text] of plan.writes) write(path, text);

  const renamedFrom = plan.renames.map(rename => rename.from);
  for (const path of renamedFrom) rmSync(join(dir, path), { force: true });

  if (prune) {
    for (const path of plan.orphans) rmSync(join(dir, path));
    for (const folder of new Set([...plan.orphans, ...renamedFrom].map(path => dirname(path)))) {
      const abs = join(dir, folder);
      if (folder !== '.' && existsSync(abs) && readdirSync(abs).every(name => name === 'folder.yml')) {
        rmSync(abs, { recursive: true });
      }
    }
  }

  const skipped = new Set(plan.skips.map(path => path.replace(NO_SPEC_MATCH, '')));
  const files = {};
  for (const [path, text] of fresh.files) {
    if (!skipped.has(path)) files[path] = plan.keptHashes.get(path) ?? sha(text);
  }
  if (!prune) {
    for (const path of plan.orphans) files[path] = plan.previous.files[path];
  }

  writeManifest(dir, {
    source,
    ...(group ? { group } : {}),
    syncedAt: new Date().toISOString(),
    files,
    keys: Object.fromEntries(fresh.keys),
  });
}
