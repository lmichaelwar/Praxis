import {
  ChevronDown,
  CircleDot,
  CloudCog,
  MoreHorizontal,
  Play,
  Redo2,
  RotateCcw,
  Undo2,
} from "lucide-react";
import { BrandMark } from "./BrandMark";
import type { PraxisWebMcpStatus } from "../usePraxisWebMcp";

interface StudioHeaderProps {
  title: string;
  revision: number;
  spendUsd: number;
  reservedUsd: number;
  maxSpendUsd: number;
  connectionStatus: "loading" | "connected" | "reconnecting" | "conflict" | "error";
  controlsDisabled: boolean;
  cloudRunActive: boolean;
  webMcpStatus: PraxisWebMcpStatus;
  submissionDemo: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onDelegate: () => void;
  onPreview: () => void;
  onRender: () => void;
  onRenderFinal: () => void;
  onReset: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

export function StudioHeader({
  title,
  revision,
  spendUsd,
  reservedUsd,
  maxSpendUsd,
  connectionStatus,
  controlsDisabled,
  cloudRunActive,
  webMcpStatus,
  submissionDemo,
  canUndo,
  canRedo,
  onDelegate,
  onPreview,
  onRender,
  onRenderFinal,
  onReset,
  onUndo,
  onRedo,
}: StudioHeaderProps) {
  const budgetPercent = Math.min(100, ((spendUsd + reservedUsd) / Math.max(maxSpendUsd, 0.01)) * 100);
  const webMcpLabel = webMcpStatus.state === "registered"
    ? `WebMCP · ${webMcpStatus.toolCount} ${webMcpStatus.access === "submission" ? "bounded tools" : "tools"}`
    : webMcpStatus.state === "unavailable"
      ? "WebMCP · unavailable"
      : webMcpStatus.state === "failed"
        ? "WebMCP · registration failed"
        : webMcpStatus.state === "registering"
          ? "WebMCP · registering"
          : "WebMCP · waiting";

  return (
    <header className="studio-header">
      <div className="studio-header__brand">
        <BrandMark />
        <span
          className="site-tools-status"
          data-state={webMcpStatus.state}
          role="status"
          aria-live="polite"
          title={webMcpLabel}
        >
          <i aria-hidden="true" />
          <span>{webMcpLabel}</span>
        </span>
      </div>
      <button className="project-title" type="button" aria-label="Open project menu">
        <span className="project-title__name">{title}</span>
        <span className="project-title__meta">Project · 30 fps · 16:9 · Stereo</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <div className="revision-block">
        <span>Revision {revision}</span>
        <small data-connection={connectionStatus}>Synced to control plane</small>
      </div>
      <div className="budget-block">
        <div className="budget-block__label">
          <span>Budget</span>
          <strong>${spendUsd.toFixed(2)} + ${reservedUsd.toFixed(2)} held / ${maxSpendUsd.toFixed(2)}</strong>
        </div>
        <span className="budget-meter" aria-label={`${budgetPercent.toFixed(0)}% of provider budget used`}>
          <span style={{ width: `${budgetPercent}%` }} />
        </span>
      </div>
      <div className="header-actions">
        <div className="history-actions" aria-label="Project history">
          <button type="button" aria-label="Undo" disabled={controlsDisabled || !canUndo} onClick={onUndo}><Undo2 size={15} /></button>
          <button type="button" aria-label="Redo" disabled={controlsDisabled || !canRedo} onClick={onRedo}><Redo2 size={15} /></button>
        </div>
        {submissionDemo ? (
          <>
            <span className="submission-demo-badge" title="Provider generation, rendering, imports, and cloud runs are disabled for this submission demo.">
              <strong>Submission demo</strong>
              <small>Existing media only</small>
            </span>
            <button className="button button--outline" type="button" disabled={controlsDisabled} onClick={onReset}>
              <RotateCcw size={15} />
              Reset demo
            </button>
          </>
        ) : (
          <button className="button button--outline button--director" type="button" disabled={controlsDisabled} onClick={onDelegate}>
            {cloudRunActive ? <CloudCog size={17} /> : <Play size={17} />}
            {cloudRunActive ? "Manage run" : "Delegate run"}
          </button>
        )}
        <button className="button button--outline" type="button" disabled={controlsDisabled} onClick={onPreview}>
          <Play size={17} />
          Preview
        </button>
        {!submissionDemo ? (
          <>
            <button className="button button--primary" type="button" disabled={controlsDisabled} onClick={onRender}>
              <CircleDot size={17} />
              Render
            </button>
            <div className="project-menu">
              <button className="icon-button" type="button" aria-label="Project actions">
                <MoreHorizontal size={18} />
              </button>
              <div className="project-menu__popover">
                <button type="button" disabled={controlsDisabled} onClick={onRenderFinal}>
                  <CircleDot size={14} /> Final render
                </button>
                <button type="button" disabled={controlsDisabled} onClick={onReset}>
                  <RotateCcw size={14} /> Reset demo
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </header>
  );
}
