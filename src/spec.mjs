import { readFileSync } from 'fs';
import yaml from 'js-yaml';

const API_DOCS_PATH = /\/(v[23]\/api-docs|swagger-resources).*$/;
const FETCH_ATTEMPTS = 3;

export const isUrl = source => /^https?:\/\//.test(source);

const baseOf = url => url.replace(API_DOCS_PATH, '').replace(/\/+$/, '');

async function fetchDocument(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`fetch failed with HTTP ${res.status}: ${url}`);
      return yaml.load(await res.text());
    } catch (error) {
      if (attempt === FETCH_ATTEMPTS || error.message.includes('HTTP')) throw error;
    }
  }
}

export async function listGroups(source) {
  const base = baseOf(source);
  const resources = await fetchDocument(`${base}/swagger-resources`);
  if (!Array.isArray(resources)) throw new Error(`no swagger groups found at ${base}`);
  return resources.map(({ name, location, url }) => ({ name, url: `${base}${location ?? url}` }));
}

export async function loadSpec(source, group) {
  if (!isUrl(source)) return yaml.load(readFileSync(source, 'utf8'));

  if (group) {
    const groups = await listGroups(source);
    const match = groups.find(g => g.name === group);
    if (!match) throw new Error(`group "${group}" not found. Available:\n  ${groups.map(g => g.name).join('\n  ')}`);
    return fetchDocument(new URL(match.url).href);
  }

  const spec = await fetchDocument(source);
  if (!spec?.paths) throw new Error(`no spec at ${source}. For a Springfox service, pick one with --group (see: groups)`);
  return spec;
}

export function prepareSpec(spec) {
  const missing = patchDanglingRefs(spec);
  stripSecurity(spec);
  return missing;
}

function patchDanglingRefs(spec) {
  const isSwagger2 = String(spec.swagger ?? '').startsWith('2');
  const prefix = isSwagger2 ? '#/definitions/' : '#/components/schemas/';
  const schemas = isSwagger2 ? (spec.definitions ??= {}) : ((spec.components ??= {}).schemas ??= {});

  const refs = new Set();
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith(prefix)) refs.add(value.slice(prefix.length));
      else walk(value);
    }
  };
  walk(spec);

  const knownTypes = {
    LocalDate: { type: 'string', format: 'date' },
    LocalDateTime: { type: 'string', format: 'date-time' },
  };
  const missing = [...refs].filter(name => !schemas[name]).sort();
  for (const name of missing) {
    schemas[name] = knownTypes[name] ?? { type: 'object', properties: {}, description: 'Stub added by bruno-sync: missing from the spec' };
  }
  return missing;
}

function stripSecurity(spec) {
  delete spec.security;
  delete spec.securityDefinitions;
  delete spec.components?.securitySchemes;
  for (const pathItem of Object.values(spec.paths ?? {})) {
    for (const operation of Object.values(pathItem)) {
      if (operation && typeof operation === 'object' && !Array.isArray(operation)) delete operation.security;
    }
  }
}

export function defaultBaseUrl(source, spec, group) {
  const fromUrl = isUrl(source);
  if (fromUrl && (group || API_DOCS_PATH.test(source))) return baseOf(source);

  const server = spec.servers?.[0]?.url;
  if (server && (fromUrl || isUrl(server))) return new URL(server, fromUrl ? source : undefined).href.replace(/\/+$/, '');

  if (spec.host) {
    const scheme = spec.schemes?.[0] ?? (fromUrl ? new URL(source).protocol.replace(':', '') : 'https');
    return `${scheme}://${spec.host}${spec.basePath ?? ''}`.replace(/\/+$/, '');
  }
  return fromUrl ? new URL(source).origin : '';
}
