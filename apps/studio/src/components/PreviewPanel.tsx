import {
  Captions,
  Expand,
  ImagePlus,
  Mic2,
  Pause,
  Play,
  Redo2,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";
import { formatFrames, type AssetVersionView, type SceneView } from "../ui-types";

interface PreviewPanelProps {
  scene: SceneView | null;
  playheadFrame: number;
  isPlaying: boolean;
  imageUrl: string;
  renderUrl?: string;
  assetVersions: readonly AssetVersionView[];
  renderRevision?: number;
  renderOutdated?: boolean;
  pending: boolean;
  mediaActionsEnabled: boolean;
  onTogglePlay: () => void;
  onSeek: (frame: number) => void;
  onGenerateImage: () => void;
  onGenerateNarration: () => void;
  onSelectAssetVersion: (versionId: string) => void;
  onAdoptAssetVersion: (versionId: string) => void;
}

export function PreviewPanel({
  scene,
  playheadFrame,
  isPlaying,
  imageUrl,
  renderUrl,
  assetVersions,
  renderRevision,
  renderOutdated,
  pending,
  mediaActionsEnabled,
  onTogglePlay,
  onSeek,
  onGenerateImage,
  onGenerateNarration,
  onSelectAssetVersion,
  onAdoptAssetVersion,
}: PreviewPanelProps) {
  const startFrame = scene?.startFrame ?? 0;
  const endFrame = startFrame + (scene?.durationFrames ?? 750);
  const progress = ((playheadFrame - startFrame) / Math.max(1, endFrame - startFrame)) * 100;
  const safeProgress = Math.max(0, Math.min(100, progress));
  const previewedAssetVersion = assetVersions.find((version) => version.selected);

  return (
    <section className="preview-panel" aria-label="Video preview">
      <div className="preview-toolbar">
        <span>Program monitor</span>
        <div className="preview-toolbar__media">
          {mediaActionsEnabled ? (
            <>
              <button type="button" disabled={pending || !scene} onClick={onGenerateImage}><ImagePlus size={11} /> Generate still</button>
              <button type="button" disabled={pending || !scene} onClick={onGenerateNarration}><Mic2 size={11} /> Narration</button>
            </>
          ) : (
            <span className="existing-media-note" title="Provider-backed media actions are disabled in the submission demo.">
              Existing media only · no generation
            </span>
          )}
          {assetVersions.length > 0 ? (
            <select
              aria-label="Selected asset version"
              disabled={pending}
              value={assetVersions.find((version) => version.selected)?.id ?? ""}
              onChange={(event) => onSelectAssetVersion(event.target.value)}
            >
              {assetVersions.map((version) => <option value={version.id} key={version.id}>{version.label}</option>)}
            </select>
          ) : null}
          {previewedAssetVersion?.unattached ? (
            <button
              className="preview-toolbar__adopt"
              type="button"
              disabled={pending}
              onClick={() => onAdoptAssetVersion(previewedAssetVersion.id)}
            >
              Adopt version
            </button>
          ) : null}
        </div>
      </div>
      <div className="preview-stage">
        {renderUrl ? (
          <video src={renderUrl} controls preload="metadata" aria-label={`Rendered project revision ${renderRevision ?? "unknown"}`} />
        ) : (
          <img
            src={imageUrl}
            alt={previewedAssetVersion?.unattached
              ? `Preview of unattached asset version ${previewedAssetVersion.id}`
              : "A fax machine waiting in an empty institutional corridor"}
          />
        )}
        <div className="preview-stage__vignette" aria-hidden="true" />
        <div className="safe-frame" aria-hidden="true" />
        {!renderUrl ? <div className="preview-title">
          <strong>{scene?.id === "scene_05" ? "AN ANSWER IS AN INVITATION" : "THE MACHINE HAS BEEN WAITING"}</strong>
        </div> : null}
        {scene?.status === "stale" ? <span className="preview-state preview-state--stale">Scene derivative stale</span> : null}
        {scene?.locked ? <span className="preview-state preview-state--locked">Director locked</span> : null}
        {previewedAssetVersion?.unattached ? (
          <span className="preview-state preview-state--unattached">Stale · unattached</span>
        ) : null}
        {renderUrl ? <span className={`preview-state preview-state--render${renderOutdated ? " is-outdated" : ""}`}>Render r{renderRevision}{renderOutdated ? " · outdated" : " · current"}</span> : null}
      </div>
      <div className="preview-scrub">
        <button type="button" aria-label="Seek preview" onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const nextProgress = (event.clientX - bounds.left) / bounds.width;
          onSeek(Math.round(startFrame + nextProgress * (endFrame - startFrame)));
        }}>
          <i style={{ width: `${safeProgress}%` }} />
          <span style={{ left: `${safeProgress}%` }} />
        </button>
      </div>
      <div className="transport-bar">
        <div className="transport-bar__group">
          <button type="button" aria-label="Jump to start" onClick={() => onSeek(startFrame)}><SkipBack size={16} /></button>
          <button type="button" aria-label="Step backward" onClick={() => onSeek(Math.max(startFrame, playheadFrame - 15))}><Redo2 size={15} className="flip-x" /></button>
          <button className="transport-play" type="button" aria-label={isPlaying ? "Pause" : "Play"} onClick={onTogglePlay}>
            {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          </button>
          <button type="button" aria-label="Step forward" onClick={() => onSeek(Math.min(endFrame, playheadFrame + 15))}><Redo2 size={15} /></button>
          <button type="button" aria-label="Jump to end" onClick={() => onSeek(endFrame)}><SkipForward size={16} /></button>
        </div>
        <output className="timecode">{formatFrames(playheadFrame)}</output>
        <div className="transport-bar__group transport-bar__group--right">
          <button type="button" aria-label="Toggle captions"><Captions size={16} /></button>
          <button type="button" aria-label="Volume"><Volume2 size={16} /></button>
          <span className="volume-meter"><i /></span>
          <button type="button" aria-label="Fullscreen preview"><Expand size={16} /></button>
        </div>
      </div>
    </section>
  );
}
