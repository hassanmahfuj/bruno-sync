import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import yaml from 'js-yaml';

const dumpYaml = doc => yaml.dump(doc, { lineWidth: -1, noRefs: true });

const brunoConfigDirs = () => [
  join(homedir(), 'snap/bruno/current/.config/bruno'),
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'bruno'),
  join(homedir(), 'Library/Application Support/bruno'),
  join(process.env.APPDATA ?? homedir(), 'bruno'),
];

function configuredWorkspace(configDir) {
  const path = join(configDir, 'preferences.json');
  if (!existsSync(path)) return undefined;
  const workspace = JSON.parse(readFileSync(path, 'utf8')).preferences?.general?.defaultWorkspacePath;
  return workspace && join(workspace, 'workspace.yml');
}

export function findWorkspace() {
  if (process.env.BRUNO_WORKSPACE) return process.env.BRUNO_WORKSPACE;
  return brunoConfigDirs()
    .flatMap(dir => [configuredWorkspace(dir), join(dir, 'default-workspace/workspace.yml')])
    .find(path => path && existsSync(path));
}

export function workspaceCollections(workspaceYml) {
  if (!workspaceYml || !existsSync(workspaceYml)) return [];
  const doc = yaml.load(readFileSync(workspaceYml, 'utf8'));
  return (doc.collections ?? []).map(({ name, path }) => ({ name, path: resolve(dirname(workspaceYml), path) }));
}

function readAuth(collectionDir) {
  const path = join(collectionDir, 'opencollection.yml');
  if (!existsSync(path)) throw new Error(`no opencollection.yml in ${collectionDir}`);
  return yaml.load(readFileSync(path, 'utf8')).request?.auth;
}

export function writeOpenCollectionYml(dir, { name, baseUrl, authFrom }) {
  const auth = authFrom ? readAuth(authFrom) : undefined;
  const doc = {
    opencollection: '1.0.0',
    info: { name },
    request: {
      ...(auth ? { auth } : {}),
      variables: [{ name: 'baseUrl', value: baseUrl }],
    },
    bundled: false,
    extensions: { bruno: { ignore: ['node_modules', '.git'] } },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'opencollection.yml'), dumpYaml(doc));
}

export function registerInWorkspace(workspaceYml, { name, path }) {
  if (!workspaceYml || !existsSync(workspaceYml)) return false;
  const doc = yaml.load(readFileSync(workspaceYml, 'utf8'));
  doc.collections ??= [];
  if (doc.collections.some(collection => collection.path === path)) return false;
  doc.collections.push({ name, path });
  writeFileSync(workspaceYml, dumpYaml(doc));
  return true;
}
