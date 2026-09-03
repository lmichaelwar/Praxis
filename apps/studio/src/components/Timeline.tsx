import { useRef, useState } from "react";
import {
  ChevronDown,
  Eye,
  LockKeyhole,
  Magnet,
  Minus,
  MousePointer2,
  Plus,
  Scissors,
  Sparkles,
  Volume2,
} from "lucide-react";
import { formatFrames, type TimelineClipView, type TrackView } from "../ui-types";

const waveformBars = Array.from({ length: 96 }, (_, index) => {
  const height = 18 + ((index * 17 + index * index * 7) % 70);
  return height;
});

interface TimelineClipProps {
  clip: TimelineClipView;
  durationFrames: number;
  selected: boolean;
  onSelect: (clip: TimelineClipView) => void;
  onMove: (clipId: string, startFrame: number) => void;
}

function TimelineClip({ clip, durationFrames, selected, onSelect, onMove }: TimelineClipProps) {
  const dragRef = useRef<{ startX: number; startFrame: number; laneWidth: number } | null>(null);
  const [previewStart, setPreviewStart] = useState<number | null>(null);
  const shownStart = previewStart ?? clip.startFrame;
  const left = (shownStart / durationFrames) * 100;
  const width = Math.max(1.6, (clip.durationFrames / durationFrames) * 100);

  return (
    <button
      className={`timeline-clip timeline-clip--${clip.kind} ${selected ? "is-selected" : ""}`}
      data-status={clip.status ?? "draft"}
      type="button"
      style={{ left: `${left}%`, width: `${width}%` }}
      onClick={() => onSelect(clip)}
      onPointerDown={(event) => {
        const lane = event.currentTarget.parentElement;
        if (!lane || clip.locked) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          startX: event.clientX,
          startFrame: clip.startFrame,
          laneWidth: lane.getBoundingClientRect().width,
        };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        const frameDelta = Math.round(((event.clientX - drag.startX) / drag.laneWidth) * durationFrames);
        setPreviewStart(Math.max(0, Math.min(durationFrames - clip.durationFrames, drag.startFrame + frameDelta)));
      }}
      onPointerUp={(event) => {
        if (!dragRef.current) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        const nextStart = previewStart ?? clip.startFrame;
        dragRef.current = null;
        setPreviewStart(null);
        if (nextStart !== clip.startFrame) onMove(clip.id, nextStart);
      }}
    >
      {clip.kind === "video" ? <span className="timeline-clip__thumb" aria-hidden="true" /> : null}
      {clip.kind === "audio" ? (
        <span className="timeline-waveform" aria-hidden="true">
          {waveformBars.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}
        </span>
      ) : null}
      <span className="timeline-clip__copy">
        <strong>{clip.label}</strong>
        {clip.kind !== "audio" ? <small>{formatFrames(clip.durationFrames)}</small> : null}
      </span>
      {clip.locked ? <LockKeyhole className="timeline-clip__lock" size={12} /> : null}
      {clip.kind === "proposal" ? <Sparkles className="timeline-clip__proposal" size={12} /> : null}
    </button>
  );
}

interface TimelineProps {
  tracks: TrackView[];
  durationFrames: number;
  playheadFrame: number;
  selectedClipId: string | null;
  onSelectClip: (clip: TimelineClipView) => void;
  onMoveClip: (clipId: string, startFrame: number) => void;
  onSeek: (frame: number) => void;
}

export function Timeline({
  tracks,
  durationFrames,
  playheadFrame,
  selectedClipId,
  onSelectClip,
  onMoveClip,
  onSeek,
}: TimelineProps) {
  const [zoom, setZoom] = useState(1);
  const rulerMarks = Array.from({ length: 11 }, (_, index) => Math.round((durationFrames / 10) * index));
  const selectedClip = tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId) ?? null;
  const playheadPercent = Math.max(0, Math.min(100, (playheadFrame / durationFrames) * 100));

  return (
    <section className="timeline-panel" aria-label="Production timeline">
      <div className="timeline-toolbar">
        <button className="sequence-selector" type="button">Sequence 01 <ChevronDown size={13} /></button>
        <span className="timeline-tool is-active"><MousePointer2 size={15} /></span>
        <button className="timeline-tool" type="button" aria-label="Blade tool"><Scissors size={15} /></button>
        <button className="timeline-tool" type="button" aria-label="Toggle snapping"><Magnet size={15} /></button>
        {selectedClip ? (
          <div className="selection-summary">
            <span>Selected</span>
            <strong>{selectedClip.label}</strong>
            <button type="button" onClick={() => onMoveClip(selectedClip.id, Math.max(0, selectedClip.startFrame - 15))}>−15f</button>
            <button type="button" onClick={() => onMoveClip(selectedClip.id, selectedClip.startFrame + 15)}>+15f</button>
          </div>
        ) : null}
        <div className="timeline-zoom">
          <button type="button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(0.8, value - 0.1))}><Minus size={13} /></button>
          <input aria-label="Timeline zoom" type="range" min="0.8" max="1.8" step="0.1" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />
          <button type="button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(1.8, value + 0.1))}><Plus size={13} /></button>
        </div>
      </div>
      <div className="timeline-scroll">
        <div className="timeline-content" style={{ width: `${zoom * 100}%` }}>
          <div className="timeline-ruler-row">
            <div className="track-header track-header--ruler" />
            <button className="timeline-ruler" type="button" aria-label="Seek timeline" onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              onSeek(Math.round(((event.clientX - bounds.left) / bounds.width) * durationFrames));
            }}>
              {rulerMarks.map((mark) => (
                <span key={mark} style={{ left: `${(mark / durationFrames) * 100}%` }}>
                  {formatFrames(mark)}
                </span>
              ))}
            </button>
          </div>
          <div className="timeline-tracks">
            <span className="timeline-playhead" style={{ left: `calc(146px + (100% - 146px) * ${playheadPercent / 100})` }} aria-hidden="true">
              <i />
            </span>
            {tracks.map((track) => (
              <div className="timeline-track" key={track.id}>
                <div className="track-header">
                  <strong>{track.label}</strong>
                  <span>{track.role}</span>
                  <button type="button" aria-label={`Toggle ${track.label} visibility`}>
                    {track.role === "music" || track.role === "narration" ? <Volume2 size={13} /> : <Eye size={13} />}
                  </button>
                </div>
                <div className="track-lane">
                  {track.clips.map((clip) => (
                    <TimelineClip
                      clip={clip}
                      durationFrames={durationFrames}
                      selected={clip.id === selectedClipId}
                      onSelect={onSelectClip}
                      onMove={onMoveClip}
                      key={clip.id}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
