import {
  CheckCircle2,
  CircleDashed,
  Clock3,
  LockKeyhole,
  LockKeyholeOpen,
  Plus,
  Search,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { formatDuration, type SceneView } from "../ui-types";

interface SceneRailProps {
  scenes: SceneView[];
  selectedSceneId: string | null;
  activeView: "script" | "scenes";
  onViewChange: (view: "script" | "scenes") => void;
  onSelectScene: (sceneId: string) => void;
  onToggleLock: (scene: SceneView) => void;
  onEditScene: (scene: SceneView) => void;
}

function SceneStatus({ scene }: { scene: SceneView }) {
  if (scene.locked) return <LockKeyhole size={16} className="scene-status scene-status--locked" />;
  if (scene.status === "stale") return <TriangleAlert size={16} className="scene-status scene-status--stale" />;
  if (scene.status === "approved") return <CheckCircle2 size={16} className="scene-status scene-status--approved" />;
  return <CircleDashed size={16} className="scene-status scene-status--draft" />;
}

export function SceneRail({
  scenes,
  selectedSceneId,
  activeView,
  onViewChange,
  onSelectScene,
  onToggleLock,
  onEditScene,
}: SceneRailProps) {
  const totalFrames = scenes.reduce((sum, scene) => sum + scene.durationFrames, 0);

  return (
    <aside className="scene-rail" aria-label="Script and scenes">
      <div className="panel-tabs">
        <button className={activeView === "script" ? "is-active" : ""} type="button" onClick={() => onViewChange("script")}>Script</button>
        <button className={activeView === "scenes" ? "is-active" : ""} type="button" onClick={() => onViewChange("scenes")}>Scenes</button>
        <span className="panel-tabs__spacer" />
        <button type="button" aria-label="Search script"><Search size={15} /></button>
        <button type="button" aria-label="Add scene"><Plus size={16} /></button>
      </div>
      <div className="rail-summary">
        <span>{scenes.length} scenes</span>
        <i />
        <span>{formatDuration(totalFrames)}</span>
        <span className="rail-summary__right"><Clock3 size={12} /> 30 fps</span>
      </div>
      <div className="scene-list">
        {scenes.map((scene) => {
          const selected = scene.id === selectedSceneId;
          return (
            <article className={`scene-row ${selected ? "is-selected" : ""}`} key={scene.id}>
              <button className="scene-row__main" type="button" onClick={() => onSelectScene(scene.id)}>
                <span className="scene-row__number">{String(scene.index).padStart(2, "0")}</span>
                <span
                  className="scene-row__thumb"
                  style={{ backgroundPosition: scene.thumbnailPosition }}
                  aria-hidden="true"
                />
                <span className="scene-row__copy">
                  <strong>{scene.title}</strong>
                  <small>{activeView === "script" ? scene.narration : scene.shotLabel}</small>
                  <span>{formatDuration(scene.durationFrames)}</span>
                </span>
                <SceneStatus scene={scene} />
              </button>
              {selected ? (
                <div className="scene-row__actions">
                  <button type="button" onClick={() => onEditScene(scene)}>
                    <Sparkles size={13} /> Revise beat
                  </button>
                  <button type="button" onClick={() => onToggleLock(scene)}>
                    {scene.locked ? <LockKeyholeOpen size={13} /> : <LockKeyhole size={13} />}
                    {scene.locked ? "Unlock" : "Lock"}
                  </button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      <footer className="scene-rail__footer">
        <Sparkles size={13} />
        <span>Structured script · synced to production graph</span>
      </footer>
    </aside>
  );
}
