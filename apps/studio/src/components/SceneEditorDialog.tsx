import { LockKeyhole, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { SceneView } from "../ui-types";

interface SceneEditorDialogProps {
  scene: SceneView | null;
  onClose: () => void;
  onSave: (sceneId: string, narration: string, visualIntent: string) => void;
}

export function SceneEditorDialog({ scene, onClose, onSave }: SceneEditorDialogProps) {
  const [narration, setNarration] = useState("");
  const [visualIntent, setVisualIntent] = useState("");

  useEffect(() => {
    setNarration(scene?.narration ?? "");
    setVisualIntent(scene?.visualIntent ?? "");
  }, [scene?.id, scene?.narration, scene?.visualIntent]);

  if (!scene) return null;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="scene-dialog" role="dialog" aria-modal="true" aria-labelledby="scene-dialog-title">
        <header>
          <div>
            <span>Beat {String(scene.index).padStart(2, "0")}</span>
            <h2 id="scene-dialog-title">{scene.title}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close scene editor" onClick={onClose}><X size={18} /></button>
        </header>
        {scene.locked ? (
          <div className="locked-note"><LockKeyhole size={15} /> Unlock this scene before changing its approved direction.</div>
        ) : null}
        <label>
          <span>Narration</span>
          <textarea rows={4} value={narration} onChange={(event) => setNarration(event.target.value)} disabled={scene.locked} />
        </label>
        <label>
          <span>Visual intent</span>
          <textarea rows={4} value={visualIntent} onChange={(event) => setVisualIntent(event.target.value)} disabled={scene.locked} />
        </label>
        <div className="scene-dialog__impact">
          <Sparkles size={16} />
          <p>This semantic edit keeps the clip in place and marks downstream voice, timing, rough cut, and render derivatives stale.</p>
        </div>
        <footer>
          <button className="button button--quiet" type="button" onClick={onClose}>Cancel</button>
          <button
            className="button button--primary"
            type="button"
            disabled={scene.locked || (narration === scene.narration && visualIntent === scene.visualIntent)}
            onClick={() => onSave(scene.id, narration, visualIntent)}
          >
            Commit revision
          </button>
        </footer>
      </section>
    </div>
  );
}
