import {
  Bot,
  Check,
  Filter,
  GitBranch,
  History,
  RotateCcw,
  ShieldAlert,
  UserRound,
} from "lucide-react";
import type { LedgerView, StudioActor } from "../ui-types";

const actorIcons: Record<StudioActor, typeof Bot> = {
  codex: Bot,
  director: UserRound,
  system: GitBranch,
};

interface LedgerPanelProps {
  entries: LedgerView[];
  onRestore: (checkpointId: string) => void;
}

export function LedgerPanel({ entries, onRestore }: LedgerPanelProps) {
  return (
    <aside className="ledger-panel" aria-label="Action ledger">
      <div className="ledger-header">
        <span>Action ledger</span>
        <button type="button"><span>All actors</span><Filter size={14} /></button>
      </div>
      <div className="ledger-list">
        {entries.map((entry) => {
          const ActorIcon = actorIcons[entry.actor];
          return (
            <article className="ledger-entry" data-actor={entry.actor} data-tone={entry.tone ?? "normal"} key={entry.id}>
              <span className="ledger-entry__rail" aria-hidden="true" />
              <ActorIcon size={16} strokeWidth={1.6} className="ledger-entry__icon" />
              <div className="ledger-entry__copy">
                <div>
                  <strong>{entry.actor}</strong>
                  <time>{entry.timestamp}</time>
                </div>
                <span>{entry.action}</span>
                <p>{entry.detail}</p>
                <small>Revision {entry.revision}</small>
              </div>
              {entry.tone === "warning" ? <ShieldAlert className="ledger-entry__state" size={15} /> : null}
              {entry.tone === "success" ? <Check className="ledger-entry__state" size={15} /> : null}
              {entry.checkpointId ? (
                <button className="ledger-entry__restore" type="button" onClick={() => onRestore(entry.checkpointId!)}>
                  <RotateCcw size={12} /> Restore
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
      <footer className="ledger-footer">
        <History size={13} />
        <span>{entries.length} reversible operations in this session</span>
      </footer>
    </aside>
  );
}
