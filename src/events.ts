export type BwrapCommandFinishReason =
  | "exit"
  | "abort"
  | "timeout"
  | "output-limit"
  | "killed"
  | "cleanup";

interface BwrapEventBase {
  readonly timestamp: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly tags: Readonly<Record<string, string>>;
}

export type BwrapSandboxEvent =
  | (BwrapEventBase & {
      readonly type: "generation.started";
    })
  | (BwrapEventBase & {
      readonly type: "command.started";
      readonly commandId: string;
      readonly pid?: number;
      readonly pgid?: number;
      readonly liveProcesses: number;
    })
  | (BwrapEventBase & {
      readonly type: "command.finished";
      readonly commandId: string;
      readonly pid?: number;
      readonly reason: BwrapCommandFinishReason;
      readonly exitCode?: number;
      readonly durationMs: number;
      readonly stdoutBytes: number;
      readonly stderrBytes: number;
      readonly liveProcesses: number;
      readonly error?: string;
    })
  | (BwrapEventBase & {
      readonly type: "cleanup.started";
      readonly requestedProcesses: number;
    })
  | (BwrapEventBase & {
      readonly type: "cleanup.completed";
      readonly requestedProcesses: number;
      readonly remainingProcesses: number;
      readonly durationMs: number;
    })
  | (BwrapEventBase & {
      readonly type: "cleanup.failed";
      readonly requestedProcesses: number;
      readonly remainingProcesses: number;
      readonly durationMs: number;
      readonly errors: readonly string[];
    });

export type BwrapSandboxEventPayload = BwrapSandboxEvent extends infer Event
  ? Event extends BwrapSandboxEvent
    ? Omit<Event, "timestamp" | "sessionId" | "generationId" | "tags">
    : never
  : never;

export type BwrapSandboxEventSink = (event: BwrapSandboxEvent) => unknown;
