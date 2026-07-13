import { storage, type Storage } from "../../../packages/storage/index.js";
import type { GoldenResponse } from "../../golden/src/types.js";

export interface LoadedGolden {
  key: string;
  golden: GoldenResponse;
}

export async function readGoldenResponses(store: Storage = storage): Promise<LoadedGolden[]> {
  const keys = (await store.blobs.list("goldens")).filter((key) => key.endsWith(".json")).sort();
  const goldens: LoadedGolden[] = [];
  for (const key of keys) {
    const bytes = await store.blobs.get(key);
    if (bytes === null) continue;
    goldens.push({ key, golden: JSON.parse(bytes.toString("utf8")) as GoldenResponse });
  }
  return goldens;
}
