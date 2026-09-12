import type { CompileProgress } from "@loom/core";

/**
 * The compile service client.
 *
 * Generation runs server-side, always. The API key never reaches the device —
 * shipping it would mean every install carries a credential that can be
 * extracted from the bundle in minutes and spent against our account.
 *
 * A full compile is a long job: eighty-odd batched scene calls plus revision
 * passes, typically minutes and occasionally the better part of an hour. So the
 * client starts a job and polls, rather than holding a request open across an
 * app backgrounding, a tunnel, or a phone call.
 */

export interface CompileJob {
  readonly id: string;
  readonly status: "queued" | "running" | "complete" | "failed" | "cancelled";
  readonly progress: CompileProgress | null;
  readonly result: CompileJobResult | null;
  readonly error: string | null;
}

export interface CompileJobResult {
  readonly words: number;
  readonly costUsd: number;
  readonly coverage: number;
  readonly reusedScenes: number;
  readonly rebuiltScenes: number;
  readonly continuityIssues: number;
  readonly continuityAssessment: string;
  readonly unusedFragments: readonly { fragmentId: string; reason: string }[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface EnrichPatch {
  readonly id: string;
  readonly enrichment: {
    kind: string;
    digest: string;
    entities: { entityId: string; surface: string; kind: string }[];
    themes: string[];
    valence: number;
    standalone: number;
    enricherVersion: string;
    enrichedAt: number;
  } | null;
  readonly embedding: number[] | null;
}

export interface ApiConfig {
  readonly baseUrl: string;
  readonly token?: string;
}

async function request<T>(config: ApiConfig, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(config.token !== undefined ? { authorization: `Bearer ${config.token}` } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(
      body.slice(0, 400) || `Request failed with ${response.status}`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

/**
 * Indexes a batch of fragments.
 *
 * Classification needs the model and the model needs the key, so the phone
 * cannot do this itself. Without this call nothing ever populates a fragment's
 * digest or embedding, clustering has nothing to cluster, and the Threads screen
 * stays empty forever.
 */
export async function enrich(
  config: ApiConfig,
  fragments: readonly { id: string; text: string; createdAt: number }[],
): Promise<{ embeddingModel: string; patches: EnrichPatch[] }> {
  return request(config, "/v1/enrich", {
    method: "POST",
    body: JSON.stringify({ fragments }),
  });
}

/**
 * Starts a compile.
 *
 * Fragments are uploaded with the request rather than assumed to be on the
 * server, because the free tier never syncs and the paid tier may simply be
 * behind. The compiler needs the notebook as it is right now, not as it was at
 * the last successful sync.
 */
export async function startCompile(
  config: ApiConfig,
  body: {
    projectId: string;
    title: string;
    form: string;
    targetWords: number;
    fragments: readonly { id: string; text: string; createdAt: number; pinned: boolean }[];
    previousState: unknown;
    skipRevision?: boolean;
  },
): Promise<{ jobId: string }> {
  return request(config, "/v1/compile", { method: "POST", body: JSON.stringify(body) });
}

export async function getJob(config: ApiConfig, jobId: string): Promise<CompileJob> {
  return request(config, `/v1/compile/${jobId}`);
}

export interface CompileSummary {
  readonly id: string;
  readonly status: CompileJob["status"];
  readonly projectId?: string;
  readonly title?: string;
  readonly createdAt: number;
  readonly finishedAt: number | null;
  readonly progress: CompileProgress | null;
  readonly error: string | null;
  readonly words: number;
}

/**
 * The account's recent compiles.
 *
 * A compile outlives the app that started it: it runs for minutes to an hour on
 * the worker, and the phone gets backgrounded, swiped away or restarted in the
 * meantime. Without this the job id lives only in a React ref, so a user who
 * closes the app loses sight of a book they have already paid for — even though
 * the worker finished it.
 */
export async function listCompiles(config: ApiConfig): Promise<{ jobs: CompileSummary[] }> {
  return request(config, "/v1/compiles");
}

export async function cancelJob(config: ApiConfig, jobId: string): Promise<void> {
  await request(config, `/v1/compile/${jobId}/cancel`, { method: "POST" });
}

/** Fetches the finished manuscript and compile state once a job completes. */
export async function getManuscript(
  config: ApiConfig,
  jobId: string,
): Promise<{ state: unknown; scenes: unknown[] }> {
  return request(config, `/v1/compile/${jobId}/manuscript`);
}

/**
 * Polls a job to completion.
 *
 * The interval widens as the job runs: early stages update every few seconds,
 * but a batched drafting stage can sit at the same percentage for many minutes,
 * and polling it every two seconds is pure battery drain.
 */
export async function pollJob(
  config: ApiConfig,
  jobId: string,
  opts: {
    onProgress?: (job: CompileJob) => void;
    signal?: AbortSignal;
    initialIntervalMs?: number;
    maxIntervalMs?: number;
  } = {},
): Promise<CompileJob> {
  let interval = opts.initialIntervalMs ?? 2_000;
  const max = opts.maxIntervalMs ?? 30_000;

  for (;;) {
    if (opts.signal?.aborted === true) throw new Error("Polling cancelled");

    const job = await getJob(config, jobId);
    opts.onProgress?.(job);

    if (job.status === "complete" || job.status === "failed" || job.status === "cancelled") {
      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(max, Math.round(interval * 1.4));
  }
}
