# `@praxis/history`

In-memory operation-history and snapshot-checkpoint primitives suitable for persistence behind an append-only adapter.

```ts
import {
  applyCommandWithHistory,
  createCheckpoint,
  createProjectHistory,
  restoreCheckpoint,
  undoLastCommand,
} from "@praxis/history";

let history = createProjectHistory(project.projectId);
const committed = applyCommandWithHistory(project, history, command);

const checkpoint = createCheckpoint(project, { label: "Approved script" });
const restored = restoreCheckpoint(project, checkpoint);
```

Undo applies a stored inverse snapshot as a new revision, so computed invalidations are reversed along with direct edits. It rejects an undo if an unrecorded intervening revision exists. Redo replays the original semantic operations against the current revision.
