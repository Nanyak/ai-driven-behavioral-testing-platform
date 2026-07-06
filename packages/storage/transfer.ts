import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { BlobStore } from "./index.js";

function safeRelative(key: string, prefix: string): string {
  const normalizedKey = key.replace(/\\/g, "/");
  const normalizedPrefix = prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalizedKey.startsWith(`${normalizedPrefix}/`)) {
    throw new Error(`Object "${key}" is outside prefix "${prefix}"`);
  }
  const rel = normalizedKey.slice(normalizedPrefix.length + 1);
  if (!rel || rel.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe object key "${key}"`);
  }
  if (
    (normalizedPrefix === "candidates" || normalizedPrefix === "validation") &&
    !rel.endsWith(".json")
  ) {
    return `${rel}.json`;
  }
  return rel;
}

export async function getDir(
  store: BlobStore,
  prefix: string,
  destination: string,
  clean = true
): Promise<number> {
  if (clean) await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  let count = 0;
  for (const objectKey of await store.list(prefix)) {
    const bytes = await store.get(objectKey);
    if (bytes === null) continue;
    const path = resolve(destination, safeRelative(objectKey, prefix));
    const root = resolve(destination);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error(`Object "${objectKey}" escapes hydration directory`);
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    count += 1;
  }
  return count;
}

async function filesUnder(root: string, dir = root): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function putDir(
  store: BlobStore,
  source: string,
  prefix: string,
  include: (relativePath: string) => boolean = () => true
): Promise<number> {
  let count = 0;
  for (const path of await filesUnder(source)) {
    const rel = relative(source, path).split(sep).join("/");
    if (!include(rel)) continue;
    await store.put(`${prefix.replace(/\/+$/g, "")}/${rel}`, await readFile(path));
    count += 1;
  }
  return count;
}
