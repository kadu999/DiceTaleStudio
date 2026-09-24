import {
  assetMetaIdOf,
  guidFromAssetMetaText,
  readProjectEntries,
  type ResourceProvider,
} from "@dts/resources";

export interface ProjectMetas {
  readonly metas: Record<string, unknown>;
  readonly unreadable: readonly { id: string; path: string; reason: string }[];
}

export interface ProjectAssetMatch {
  readonly id: string;
  readonly path: string;
}

/** Reads sidecar metadata keyed by the asset ID; unreadable files remain distinguishable from missing ones. */
export async function readProjectMetas(provider: ResourceProvider, project: string): Promise<ProjectMetas> {
  const entries = await readProjectEntries(provider, project);
  const metas: Record<string, unknown> = {};
  const unreadable: Array<{ id: string; path: string; reason: string }> = [];

  for (const entry of entries) {
    if (entry.type !== "file") {
      continue;
    }

    const metaId = assetMetaIdOf(entry.id);
    if (!(await provider.exists(metaId))) {
      continue;
    }

    try {
      metas[entry.id] = JSON.parse(await provider.readText(metaId)) as unknown;
    } catch (error) {
      unreadable.push({
        id: entry.id,
        path: entry.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { metas, unreadable };
}

/** Returns all matching assets so the HTTP layer can report missing and duplicate GUIDs distinctly. */
export async function findProjectAssetsByGuid(
  provider: ResourceProvider,
  project: string,
  guid: string,
): Promise<ProjectAssetMatch[]> {
  const entries = await readProjectEntries(provider, project);
  const matches: ProjectAssetMatch[] = [];

  for (const entry of entries) {
    if (entry.type !== "file") {
      continue;
    }

    const metaId = assetMetaIdOf(entry.id);
    if (metaId === undefined || !(await provider.exists(metaId))) {
      continue;
    }

    if (guidFromAssetMetaText(await provider.readText(metaId)) === guid) {
      matches.push({ id: entry.id, path: entry.path.slice(project.length + 1) });
    }
  }

  return matches;
}
