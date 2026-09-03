# `@praxis/project-schema`

Canonical Zod schemas and TypeScript types for a revisioned Praxis production.

```ts
import {
  createSeedProject,
  ProductionProjectSchema,
  type ProductionProject,
} from "@praxis/project-schema";

const project: ProductionProject = createSeedProject();
ProductionProjectSchema.parse(project);
```

The seed is deterministic and returns a fresh five-scene, 25-second “Fax Oracle” project with linked beats, scenes, versioned assets, V1/V2/A1/A2 tracks, one locked scene, one stale derivative chain, a proposal, and a checkpoint reference.

Immutable asset versions may carry an object-store key, SHA-256 digest, byte length, duration, and bounded job provenance; media bytes never enter this graph. Timeline clips expose bounded text/style and audio-gain fields so a trusted renderer can compile the snapshot without evaluating generated code.
