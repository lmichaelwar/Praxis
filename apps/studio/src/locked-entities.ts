import type { EntityMeta, ProductionProject } from "@praxis/project-schema";

/**
 * Returns every canonical project entity protected by `meta.locked`.
 * A Set keeps the capability denial list stable even while older snapshots roll
 * through migrations that may not yet satisfy the global entity-ID invariant.
 */
export function lockedEntityIds(project: ProductionProject): string[] {
  const ids = new Set<string>();
  const include = (meta: EntityMeta) => {
    if (meta.locked) ids.add(meta.id);
  };

  for (const beat of project.script.beats) include(beat.meta);
  for (const scene of project.scenes) include(scene.meta);
  for (const asset of Object.values(project.assets)) include(asset.meta);
  include(project.timeline.meta);
  for (const track of project.timeline.tracks) {
    include(track.meta);
    for (const clip of track.clips) include(clip.meta);
  }
  for (const decision of project.decisions) include(decision.meta);

  return [...ids];
}
