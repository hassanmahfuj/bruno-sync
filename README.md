# bruno-sync

Creates and updates Bruno collections from a Swagger 2.0 or OpenAPI 3 spec. Requests you have edited are left alone.

## Setup

Needs Node. Run `npm install` once. There is nothing to configure: the tool finds your Bruno workspace by itself.

## Usage

Create a collection from a URL or a local JSON or YAML file:

```bash
./bruno-sync.mjs create https://example.com/openapi.json ~/bruno/my-api --name "My API"
```

Preview changes, then apply them:

```bash
./bruno-sync.mjs status "My API"
./bruno-sync.mjs update "My API"
```

Quit Bruno before running anything that writes, and reopen it afterwards.

## Commands

| Command | What it does |
|---|---|
| `groups <url>` | Lists the swagger groups at a Springfox service |
| `list` | Lists the synced collections in the Bruno workspace |
| `create <source> [dir]` | Creates a collection from a spec URL or file |
| `create <url> [dir] --all-groups` | Creates one collection per swagger group, inside `dir` |
| `link <dir> <source>` | Connects an existing collection to a spec |
| `status <dir>` | Shows what an update would do, without writing |
| `update <dir>` | Syncs a collection with its spec |
| `status --all`, `update --all` | The same, for every synced collection in the workspace |

`<dir>` is a path, or the name of a collection in the workspace. New collections go in the current folder unless you give a path.

| Flag | Used with | Meaning |
|---|---|---|
| `--group <name>` | `create`, `link` | Swagger group to use, as shown by `groups` |
| `--name <name>` | `create` | Collection name; defaults to the group or spec title |
| `--auth-from <dir>` | `create` | Copy auth from another collection, including saved credentials |
| `--base-url <url>` | `create` | Set the `baseUrl` variable yourself |
| `--prune` | `update` | Delete orphaned requests you never edited |
| `--dry-run` | `update` | Preview only, same as `status` |
| `--force` | writes | Write even while Bruno is running |

## Springfox services

```bash
./bruno-sync.mjs groups https://example.com/my-service
./bruno-sync.mjs create https://example.com/my-service ~/bruno/my-service --group "My Group"
```

Use `--all-groups` instead of `--group` to create all of them.

## What update does

| Situation | Result |
|---|---|
| File untouched, spec changed | Replaced with the new version |
| File edited by you | Skipped and reported |
| File missing from disk | Created |
| Endpoint gone from spec, file untouched | Reported; deleted only with `--prune` |
| Endpoint gone from spec, file edited | Reported and kept |

- `opencollection.yml` is never changed, so your auth and variables are safe.
- `folder.yml` files are always regenerated, so changes to them are overwritten.
- Changing only the display order doesn't count as an edit.
- To reset a request, delete its file and run `update`. This is also the only way to get spec changes into a request you edited.

Each collection stores its source and file hashes in `.bruno-sync.json`. Don't edit it by hand; use `link` to change the source.

## Bruno workspace

The tool uses the workspace set as `defaultWorkspacePath` in Bruno's `preferences.json`, or `default-workspace/workspace.yml` if that isn't set. Set `BRUNO_WORKSPACE=/path/to/workspace.yml` to use a different one.

`list`, `--all` and collection names only see collections in that workspace. If you move a collection's folder, update its path in `workspace.yml`, or remove it in Bruno first and open it again afterwards.

Environments aren't managed by this tool. An active environment with a `baseUrl` overrides the one in the collection.

## Project files

| Path | Purpose |
|---|---|
| `bruno-sync.mjs` | Commands and flags |
| `src/spec.mjs` | Loading specs, group discovery, patching, stripping security |
| `src/generate.mjs` | Turning converter output into files, using `@usebruno/converters` |
| `src/sync.mjs` | Edit detection, manifest, writing and pruning |
| `src/collection.mjs` | `opencollection.yml`, finding and updating the workspace |
