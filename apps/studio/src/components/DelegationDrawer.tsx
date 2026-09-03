import {
  BookmarkCheck,
  Check,
  CloudCog,
  DollarSign,
  LockKeyhole,
  Save,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  STAGE_ORDER,
  type AuthorityMode,
  type DelegationDraft,
  type StudioStageName,
} from "../ui-types";

const stageLabels: Record<StudioStageName, string> = {
  treatment: "Treatment",
  script: "Script",
  previz: "Previz",
  assets: "Assets",
  edit: "Edit",
  finish: "Finish",
};

const modes: Array<Exclude<AuthorityMode, "locked">> = ["observe", "propose", "act"];

interface DelegationDrawerProps {
  open: boolean;
  revision: number;
  draft: DelegationDraft;
  onChange: (draft: DelegationDraft) => void;
  onClose: () => void;
  onSave: () => void;
  onStart: () => void;
}

export function DelegationDrawer({
  open,
  revision,
  draft,
  onChange,
  onClose,
  onSave,
  onStart,
}: DelegationDrawerProps) {
  if (!open) return null;

  const actingStages = STAGE_ORDER.filter((stage) => draft.modes[stage] === "act").map((stage) => stageLabels[stage]);
  const proposingStages = STAGE_ORDER.filter((stage) => draft.modes[stage] === "propose").map((stage) => stageLabels[stage]);

  const updateMode = (stage: StudioStageName, mode: AuthorityMode) => {
    onChange({ ...draft, modes: { ...draft.modes, [stage]: mode } });
  };

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="delegation-drawer" role="dialog" aria-modal="true" aria-labelledby="delegation-title">
        <header className="drawer-header">
          <div>
            <h2 id="delegation-title">Delegate production run</h2>
            <p>Codex can take one stage or the whole stack. You can step back in at any time.</p>
          </div>
          <button className="icon-button" type="button" aria-label="Close delegation panel" onClick={onClose}><X size={20} /></button>
        </header>

        <div className="authority-matrix">
          <div className="authority-matrix__head">
            <span>Stage</span>
            <span>Codex authority</span>
          </div>
          {STAGE_ORDER.map((stage) => (
            <div className="authority-row" key={stage}>
              <strong>{stageLabels[stage]}</strong>
              <div className="segmented-control" aria-label={`${stageLabels[stage]} delegation mode`}>
                {modes.map((mode) => (
                  <button
                    className={draft.modes[stage] === mode ? "is-selected" : ""}
                    data-mode={mode}
                    type="button"
                    onClick={() => updateMode(stage, mode)}
                    key={mode}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="delegation-options">
          <div className="delegation-option delegation-option--scope">
            <span>Scope</span>
            <strong>Revise script → Revise scene plan → Rough cut</strong>
          </div>
          <label className="delegation-option">
            <span><LockKeyhole size={16} /> Preserve locked entities</span>
            <input
              type="checkbox"
              checked
              disabled
              readOnly
            />
            <i className="toggle" aria-hidden="true" />
          </label>
          <label className="delegation-option">
            <span><BookmarkCheck size={16} /> Create checkpoint before run</span>
            <input
              type="checkbox"
              checked
              disabled
              readOnly
            />
            <i className="toggle" aria-hidden="true" />
          </label>
          <label className="delegation-option delegation-option--budget">
            <span><DollarSign size={16} /> Provider spend limit</span>
            <div className="budget-stepper">
              <button type="button" onClick={() => onChange({ ...draft, maxSpendUsd: Math.max(0, draft.maxSpendUsd - 0.25) })}>−</button>
              <output>${draft.maxSpendUsd.toFixed(2)}</output>
              <button type="button" onClick={() => onChange({ ...draft, maxSpendUsd: draft.maxSpendUsd + 0.25 })}>+</button>
            </div>
          </label>
        </div>

        <div className="permission-summary">
          <ShieldCheck size={24} />
          <div>
            <strong>Permission summary</strong>
            <p>Codex can act on {actingStages.join(", ") || "no stages"}.</p>
            <p>Codex can propose on {proposingStages.join(", ") || "no stages"}.</p>
            <p>Locked entities will be preserved. You can take back control at any time.</p>
          </div>
          <Check size={18} />
        </div>

        <div className="revision-note">
          Current revision <strong>{revision}</strong>. Saving authority and the initial checkpoint will advance the run base.
        </div>

        <footer className="drawer-actions">
          <button
            className="button button--codex"
            type="button"
            disabled={actingStages.length === 0}
            title={actingStages.length === 0 ? "Select act authority for at least one stage" : undefined}
            onClick={onStart}
          >
            <CloudCog size={17} /> TAKE THE STACK
          </button>
          <button className="button button--outline" type="button" onClick={onSave}>
            <Save size={16} /> Save delegation
          </button>
          <button className="button button--quiet" type="button" onClick={onClose}>Cancel</button>
        </footer>
      </section>
    </div>
  );
}
