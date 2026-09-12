import {
  asChapterId,
  asFragmentId,
  asSceneId,
  type CompileProgress,
  type DraftedScene,
  type PassName,
  type Project,
} from "@loom/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDatabase } from "@/db/provider";
import {
  cancelJob,
  getManuscript,
  listCompiles,
  pollJob,
  startCompile,
  type ApiConfig,
  type CompileJob,
} from "./api";
import { isConfigured, useSettings } from "./settings";

/**
 * Driving a compile from the app.
 *
 * The shape is: upload the notebook, poll the job, then write the finished
 * manuscript into local SQLite. That last step matters — once a compile lands,
 * the book is readable offline forever, exactly like the notes it came from.
 *
 * Fragments are uploaded with the request rather than assumed to be on the
 * server. The free tier never syncs and the paid tier may simply be behind; the
 * compiler needs the notebook as it is now, not as it was at the last sync.
 *
 * A compile outlives the screen that started it. Jobs are durable on the worker,
 * so the app re-attaches to one still running for this project when it opens,
 * rather than showing an idle button for a book that is halfway written.
 */

export type CompileStatus =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "running"; progress: CompileProgress | null; jobId: string }
  | { phase: "saving" }
  | { phase: "done"; words: number; costUsd: number; coverage: number; unused: number }
  | { phase: "failed"; error: string };

export function useCompile(project: Project | null) {
  const { db, touch } = useDatabase();
  const { settings } = useSettings();
  const [status, setStatus] = useState<CompileStatus>({ phase: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const jobRef = useRef<{ config: ApiConfig; jobId: string } | null>(null);
  const attached = useRef<string | null>(null);

  const cancel = useCallback(async () => {
    abortRef.current?.abort();
    const inflight = jobRef.current;
    if (inflight !== null) {
      await cancelJob(inflight.config, inflight.jobId).catch(() => undefined);
    }
    setStatus({ phase: "idle" });
  }, []);

  /**
   * Follows a job to its end and writes the result into local SQLite.
   *
   * Shared by starting a compile and by re-attaching to one, because the two
   * differ only in how the job id was obtained. Landing the manuscript locally is
   * the step that matters: once it is written, the book is readable offline
   * forever, exactly like the notes it came from.
   */
  const watch = useCallback(
    async (config: ApiConfig, jobId: string, controller: AbortController) => {
      if (project === null) return;

      const finished: CompileJob = await pollJob(config, jobId, {
        signal: controller.signal,
        onProgress: (job) => setStatus({ phase: "running", progress: job.progress, jobId }),
      });

      if (finished.status === "cancelled") {
        setStatus({ phase: "idle" });
        return;
      }
      if (finished.status === "failed" || finished.result === null) {
        setStatus({ phase: "failed", error: finished.error ?? "The compile failed." });
        return;
      }

      setStatus({ phase: "saving" });
      const { state, scenes } = await getManuscript(config, jobId);

      const drafted = (scenes as RawScene[]).map(toDraftedScene);
      await db.saveScenes(project.id, drafted);
      await db.pruneScenes(
        project.id,
        drafted.map((s) => s.sceneId as string),
      );
      await db.saveCompileState(project.id, state as Parameters<typeof db.saveCompileState>[1]);
      touch();

      setStatus({
        phase: "done",
        words: finished.result.words,
        costUsd: finished.result.costUsd,
        coverage: finished.result.coverage,
        unused: finished.result.unusedFragments.length,
      });
    },
    [db, project, touch],
  );

  const start = useCallback(async () => {
    if (project === null) return;
    if (!isConfigured(settings)) {
      setStatus({
        phase: "failed",
        error: "Add your compile service in Settings before writing a book.",
      });
      return;
    }

    const config: ApiConfig = { baseUrl: settings.baseUrl, token: settings.token };
    const controller = new AbortController();
    let startedJob: { config: ApiConfig; jobId: string } | null = null;
    abortRef.current = controller;
    setStatus({ phase: "starting" });

    try {
      const fragments = await db.allUsableFragments(project.id);
      if (fragments.length === 0) {
        setStatus({ phase: "failed", error: "This book has no notes assigned to it yet." });
        return;
      }

      const previousState = await db.loadCompileState(project.id);

      const { jobId } = await startCompile(config, {
        projectId: project.id as string,
        title: project.title,
        form: project.form,
        targetWords: project.targetWords,
        fragments: fragments.map((f) => ({
          id: f.id as string,
          text: f.text,
          createdAt: f.createdAt,
          pinned: f.pinned,
        })),
        previousState,
      });

      startedJob = { config, jobId };
      jobRef.current = startedJob;
      await watch(config, jobId, controller);
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        setStatus({ phase: "idle" });
        return;
      }
      setStatus({
        phase: "failed",
        error: err instanceof Error ? err.message : "Something went wrong.",
      });
    } finally {
      if (startedJob !== null && jobRef.current === startedJob) jobRef.current = null;
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [db, project, settings, touch, watch]);

  /**
   * Re-attaches to a compile this project already has running on the worker.
   *
   * Called when the screen opens. The worker is the durable record of what is in
   * flight, so there is nothing to remember on the device — which is also why
   * this survives a reinstall, not just a backgrounding.
   */
  const resume = useCallback(async () => {
    if (project === null) return false;
    if (!isConfigured(settings)) return false;

    const config: ApiConfig = { baseUrl: settings.baseUrl, token: settings.token };
    const controller = new AbortController();
    let resumedJob: { config: ApiConfig; jobId: string } | null = null;
    let didAttach = false;

    try {
      const { jobs } = await listCompiles(config);
      // A compile may have been started while the discovery request was in flight.
      if (jobRef.current !== null || abortRef.current !== null) return false;
      const inflight = jobs.find(
        (j) =>
          j.projectId === (project.id as string) &&
          (j.status === "queued" || j.status === "running"),
      );
      if (inflight === undefined) return false;

      abortRef.current = controller;
      resumedJob = { config, jobId: inflight.id };
      jobRef.current = resumedJob;
      didAttach = true;
      setStatus({ phase: "running", progress: inflight.progress, jobId: inflight.id });

      await watch(config, inflight.id, controller);
      return true;
    } catch (err: unknown) {
      // A worker that is unreachable at launch is not an error worth showing:
      // the user has not asked for anything yet.
      if (!didAttach) return false;
      if (controller.signal.aborted) {
        setStatus({ phase: "idle" });
      } else {
        setStatus({
          phase: "failed",
          error: err instanceof Error ? err.message : "Something went wrong.",
        });
      }
      return true;
    } finally {
      if (jobRef.current === resumedJob) jobRef.current = null;
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [project, settings, watch]);

  // Attach once per project, and only when nothing else is already happening.
  useEffect(() => {
    if (project === null) return;
    const key = project.id as string;
    if (attached.current === key) return;
    attached.current = key;
    void resume();
  }, [project, resume]);

  return { status, start, cancel, resume, reset: () => setStatus({ phase: "idle" }) };
}

interface RawScene {
  sceneId: string;
  chapterId: string;
  prose: string;
  wordCount: number;
  contentHash: string;
  passes: string[];
  usedFragments: string[];
  model: string;
  costUsd: number;
  draftedAt: number;
}

/** Rebrands the wire shape. JSON has no notion of our branded ids. */
function toDraftedScene(raw: RawScene): DraftedScene {
  return {
    sceneId: asSceneId(raw.sceneId),
    chapterId: asChapterId(raw.chapterId),
    prose: raw.prose,
    wordCount: raw.wordCount,
    contentHash: raw.contentHash,
    passes: raw.passes as PassName[],
    usedFragments: raw.usedFragments.map(asFragmentId),
    model: raw.model,
    costUsd: raw.costUsd,
    draftedAt: raw.draftedAt,
  };
}
