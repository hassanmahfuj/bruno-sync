import { openApiToBruno, brunoToOpenCollection } from '@usebruno/converters';
import yaml from 'js-yaml';
import { createHash } from 'crypto';

const dumpYaml = obj => yaml.dump(obj, { lineWidth: -1, noRefs: true }) + '\n';

const sanitize = name =>
  name.replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim();

const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);

export const sha = text => createHash('sha256').update(text).digest('hex');

export async function buildFiles(spec) {
  const collection = await openApiToBruno(spec);
  const openCollection = brunoToOpenCollection({ name: collection.name, items: collection.items, root: collection.root });

  const files = new Map();
  const keys = new Map();
  let seq = 1;

  const addRequest = (folder, request) => {
    const item = {
      info: { ...request.info, seq: seq++ },
      http: request.http,
      settings: request.settings,
      ...(request.docs ? { docs: request.docs } : {}),
      ...(request.examples?.length ? { examples: request.examples } : {}),
    };
    const folderDir = folder ? sanitize(folder.info.name) : '';
    const base = sanitize(item.info.name) || 'request';
    let filename = `${base}.yml`;
    for (let n = 2; files.has(joinPath(folderDir, filename)); n++) filename = `${base} (${n}).yml`;

    const path = joinPath(folderDir, filename);
    files.set(path, dumpYaml(item));
    const url = (request.http.url ?? '').replace(/^\{\{baseUrl\}\}/, '');
    keys.set(`${folderDir}::${request.http.method} ${url}`, path);
  };

  for (const entry of openCollection.items) {
    if (entry.info?.type === 'folder') {
      const { info, request = {}, docs } = entry;
      files.set(joinPath(sanitize(info.name), 'folder.yml'), dumpYaml({ info, request, ...(docs ? { docs } : {}) }));
      for (const request of entry.items ?? []) addRequest(entry, request);
    } else if (entry.http) {
      addRequest(null, entry);
    }
  }

  return { title: openCollection.info?.name, files, keys };
}
