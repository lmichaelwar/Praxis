import {
  Box,
  Clapperboard,
  FileText,
  Film,
  Flag,
  Layers3,
  LockKeyhole,
} from "lucide-react";
import type { StageView, StudioStageName } from "../ui-types";

const icons = {
  treatment: FileText,
  script: Layers3,
  previz: Clapperboard,
  assets: Box,
  edit: Film,
  finish: Flag,
};

interface StageRailProps {
  stages: StageView[];
  activeStage: StudioStageName;
  onSelectStage: (stage: StudioStageName) => void;
}

export function StageRail({ stages, activeStage, onSelectStage }: StageRailProps) {
  return (
    <nav className="stage-rail" aria-label="Production stages">
      <div className="stage-rail__items">
        {stages.map((stage, index) => {
          const Icon = icons[stage.id];
          return (
            <div className="stage-step-wrap" key={stage.id}>
              <button
                className={`stage-step ${activeStage === stage.id ? "is-active" : ""}`}
                data-status={stage.status}
                type="button"
                onClick={() => onSelectStage(stage.id)}
              >
                <Icon size={18} strokeWidth={1.6} />
                <span>
                  <strong>{stage.label}</strong>
                  <small>{stage.mode}</small>
                </span>
              </button>
              {index < stages.length - 1 ? <span className="stage-step__connector" aria-hidden="true" /> : null}
            </div>
          );
        })}
      </div>
      <div className="stage-legend" aria-label="Status legend">
        <span><i className="dot dot--director" /> Director</span>
        <span><i className="dot dot--codex" /> Codex</span>
        <span><i className="dot dot--stale" /> Stale</span>
        <span><LockKeyhole size={12} /> Locked</span>
      </div>
    </nav>
  );
}
