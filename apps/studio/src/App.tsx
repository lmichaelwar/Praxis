import { CloudRunStrip } from "./components/CloudRunStrip";
import { DelegationDrawer } from "./components/DelegationDrawer";
import { LedgerPanel } from "./components/LedgerPanel";
import { PreviewPanel } from "./components/PreviewPanel";
import { SceneEditorDialog } from "./components/SceneEditorDialog";
import { SceneRail } from "./components/SceneRail";
import { StageRail } from "./components/StageRail";
import { StudioHeader } from "./components/StudioHeader";
import { Timeline } from "./components/Timeline";
import { ToastStack } from "./components/ToastStack";
import { STUDIO_CAPABILITIES } from "./studio-capabilities";
import { usePraxisStudio } from "./usePraxisStudio";
import { usePraxisWebMcp } from "./usePraxisWebMcp";

export default function App() {
  const studio = usePraxisStudio();
  const submissionDemo = STUDIO_CAPABILITIES.mode === "submission-demo";
  const webMcpStatus = usePraxisWebMcp(studio, submissionDemo);
  const controlsDisabled = !studio.isReady || studio.pendingActions > 0;

  return (
    <main
      className="praxis-app"
      data-studio-mode={STUDIO_CAPABILITIES.mode}
      data-webmcp={webMcpStatus.state}
      aria-busy={!studio.isReady || studio.connection.status === "reconnecting"}
    >
      <StudioHeader
        title={studio.project.metadata.title}
        revision={studio.project.revision}
        spendUsd={studio.spendUsd}
        reservedUsd={studio.reservedUsd}
        maxSpendUsd={studio.budget.maxSpendUsd}
        connectionStatus={studio.connection.status}
        controlsDisabled={controlsDisabled}
        cloudRunActive={![
          "idle",
          "completed",
          "failed",
          "cancelled",
        ].includes(studio.cloudRun.status)}
        webMcpStatus={webMcpStatus}
        submissionDemo={submissionDemo}
        canUndo={studio.history.canUndo}
        canRedo={studio.history.canRedo}
        onDelegate={() => studio.setDelegationOpen(true)}
        onPreview={() => studio.setIsPlaying((playing) => !playing)}
        onRender={studio.requestRender}
        onRenderFinal={studio.requestFinalRender}
        onReset={studio.resetDemo}
        onUndo={studio.undo}
        onRedo={studio.redo}
      />

      <StageRail
        stages={studio.stages}
        activeStage={studio.activeStage}
        onSelectStage={studio.setActiveStage}
      />

      <CloudRunStrip
        run={studio.cloudRun}
        jobs={studio.jobQueue}
        connection={studio.connection}
        submissionDemo={submissionDemo}
        onCancel={() => { void studio.cancelCloudRun(); }}
        onCancelJob={(jobId) => { void studio.cancelJob(jobId); }}
        onRetry={() => { void studio.retryConnection(); }}
      />

      <div className="workbench">
        <SceneRail
          scenes={studio.scenes}
          selectedSceneId={studio.selection.sceneId}
          activeView={studio.selection.activeView}
          onViewChange={(activeView) => studio.setSelection((current) => ({ ...current, activeView }))}
          onSelectScene={studio.selectScene}
          onToggleLock={(scene) => studio.toggleSceneLock(scene.id, !scene.locked)}
          onEditScene={(scene) => studio.setEditingSceneId(scene.id)}
        />

        <PreviewPanel
          scene={studio.selectedScene}
          playheadFrame={studio.selection.playheadFrame}
          isPlaying={studio.isPlaying}
          imageUrl={studio.previewAssetUrl}
          renderUrl={studio.renderPlaybackUrl}
          assetVersions={studio.assetVersions}
          renderRevision={studio.renderRevision}
          renderOutdated={studio.renderOutdated}
          pending={controlsDisabled}
          mediaActionsEnabled={STUDIO_CAPABILITIES.mediaActions}
          onTogglePlay={() => studio.setIsPlaying((playing) => !playing)}
          onSeek={studio.setPlayheadFrame}
          onGenerateImage={() => { void studio.generateSceneAsset(); }}
          onGenerateNarration={() => { void studio.generateNarration(); }}
          onSelectAssetVersion={(versionId) => { void studio.selectAssetVersion(versionId); }}
          onAdoptAssetVersion={(versionId) => { void studio.adoptAssetVersion(versionId); }}
        />

        <LedgerPanel entries={studio.ledger} onRestore={(checkpointId) => studio.restoreCheckpoint(checkpointId)} />
      </div>

      <Timeline
        tracks={studio.tracks}
        durationFrames={studio.project.timeline.durationFrames}
        playheadFrame={studio.selection.playheadFrame}
        selectedClipId={studio.selection.clipId}
        onSelectClip={(clip) => studio.selectClip(clip.id, clip.sceneId)}
        onMoveClip={studio.moveClip}
        onSeek={studio.setPlayheadFrame}
      />

      {STUDIO_CAPABILITIES.delegationActions ? (
        <DelegationDrawer
          open={studio.delegationOpen}
          revision={studio.project.revision}
          draft={studio.delegationDraft}
          onChange={studio.setDelegationDraft}
          onClose={() => studio.setDelegationOpen(false)}
          onSave={studio.saveDelegation}
          onStart={studio.startCloudRun}
        />
      ) : null}

      <SceneEditorDialog
        scene={studio.editingScene}
        onClose={() => studio.setEditingSceneId(null)}
        onSave={studio.updateSceneBeat}
      />

      <ToastStack toasts={studio.toasts} onDismiss={studio.dismissToast} />

      {!studio.isReady ? (
        <div className="connection-overlay" role="alert">
          <div>
            <span>Praxis control plane</span>
            <h1>{studio.connection.status === "error" ? "Project unavailable" : "Hydrating project"}</h1>
            <p>{studio.connection.message}</p>
            {studio.connection.status === "error" ? (
              <button className="button button--primary" type="button" onClick={() => { void studio.retryConnection(); }}>Retry connection</button>
            ) : <i className="connection-overlay__loader" />}
          </div>
        </div>
      ) : null}
    </main>
  );
}
