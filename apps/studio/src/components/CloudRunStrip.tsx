import { AlertTriangle, Check, CloudCog, RefreshCw, X } from "lucide-react";
import type { BackendConnectionView, CloudRunView, JobQueueView } from "../ui-types";

interface CloudRunStripProps {
  run: CloudRunView;
  jobs: readonly JobQueueView[];
  connection: BackendConnectionView;
  submissionDemo: boolean;
  onCancel: () => void;
  onCancelJob: (jobId: string) => void;
  onRetry: () => void;
}

const jobLabel = (job: JobQueueView) => job.type.replace(".generate", "").replace("render.", "render ");
const terminalRunStatuses = new Set(["completed", "failed", "cancelled"]);

const runStatusLabel = (status: CloudRunView["status"]) => {
  if (status === "idle") return "No delegated run";
  if (status === "dispatch_unknown") return "Dispatch unknown";
  if (status === "waiting_on_jobs") return "Waiting on jobs";
  return status.replaceAll("_", " ");
};

export function CloudRunStrip({
  run,
  jobs,
  connection,
  submissionDemo,
  onCancel,
  onCancelJob,
  onRetry,
}: CloudRunStripProps) {
  const latestJobs = jobs.slice(0, 4);
  const connected = connection.status === "connected";

  return (
    <div className="cloud-run-strip" role="status" aria-live="polite" data-connection={connection.status}>
      <div className="cloud-run-strip__identity">
        {connected ? <Check size={14} /> : connection.status === "error" || connection.status === "conflict" ? <AlertTriangle size={14} /> : <RefreshCw className="spin" size={14} />}
        <strong>Control plane</strong>
        <span>{connection.message}</span>
      </div>

      <div className="cloud-run-strip__jobs" aria-label="Durable AgentRun and media jobs">
        {submissionDemo ? <span className="job-chip submission-demo-chip">Submission demo · cloud runs disabled</span> : null}
        {run.status !== "idle" ? (
          <span
            className="job-chip agent-run-chip"
            data-status={run.status}
            title={run.errorMessage ?? run.completionSummary ?? `AgentRun from revision ${run.baseRevision}`}
          >
            <i />
            <strong>{run.role === "reviewer" ? "reviewer" : "agent run"}</strong>
            <span>{runStatusLabel(run.status)}</span>
            <small>r{run.baseRevision} · ${run.maxSpendUsd.toFixed(2)} cap</small>
            {run.codexTaskUrl && !submissionDemo ? <a href={run.codexTaskUrl} target="_blank" rel="noreferrer">task</a> : null}
          </span>
        ) : null}
        {latestJobs.length === 0 ? <span className="job-chip job-chip--empty">No media jobs</span> : latestJobs.map((job) => (
          <span className="job-chip" data-status={job.status} key={job.id} title={job.error ?? `${job.type} at revision ${job.baseRevision}`}>
            <i />
            <strong>{jobLabel(job)}</strong>
            <span>{job.status.replace("_", " ")}</span>
            {job.stale ? <em>stale</em> : null}
            {job.settledCostUsd > 0 ? <small>${job.settledCostUsd.toFixed(3)}</small> : job.reservedCostUsd > 0 ? <small>${job.reservedCostUsd.toFixed(3)} held</small> : null}
            {job.cancellable && !submissionDemo ? (
              <button type="button" aria-label={`Cancel ${job.type} job`} onClick={() => onCancelJob(job.id)}><X size={11} /></button>
            ) : null}
          </span>
        ))}
      </div>

      <div className="cloud-run-strip__actions">
        {connection.status !== "connected" ? (
          <button type="button" aria-label="Retry control plane connection" onClick={onRetry}><RefreshCw size={14} /></button>
        ) : null}
        {!submissionDemo && run.status !== "idle" && !terminalRunStatuses.has(run.status) ? (
          <button type="button" aria-label="Cancel delegated AgentRun" onClick={onCancel}><CloudCog size={14} /><X size={10} /></button>
        ) : null}
      </div>
    </div>
  );
}
