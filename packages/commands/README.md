# `@praxis/commands`

The only mutation path for a Praxis project. `applyProjectCommand` never mutates its inputs and commits a batch only after every operation and the resulting project validate.

```ts
import { applyProjectCommand, createProjectCommand } from "@praxis/commands";

const command = createProjectCommand(project.projectId, project.revision, [
  {
    type: "script.updateBeat",
    beatId: "beat_01",
    patch: { narration: "A revised line." },
  },
]);

const applied = applyProjectCommand(project, command);
if (applied.ok) project = applied.project;
else console.error(applied.error.code, applied.error.summary);
```

Public operation discriminators are:

- `script.updateBeat`
- `scene.setLocked`, `scene.setStatus`
- `timeline.moveClip`, `timeline.insertClip`, `timeline.updateClip`, `timeline.removeClip`
- `asset.create`, `asset.addVersion`, `asset.selectVersion`
- `delegation.set`
- `proposal.accept`, `proposal.reject`
- `checkpoint.add`, `checkpoint.remove`
- `project.restore`

`decision.setState` is serializable for inverse/history use. Successful results include a snapshot-backed `inverseCommand`; failures include the untouched input project and a structured error such as `REVISION_CONFLICT` or `ENTITY_LOCKED`.

Asset creation and immutable-version commits are limited to director and system actors. A completed media worker appends a finalized version and selects it in the same atomic command; direct Codex callers must dispatch a media job instead. Selecting a version respects asset and consumer locks, updates follow-latest clips, and marks downstream edit/finish state stale.
