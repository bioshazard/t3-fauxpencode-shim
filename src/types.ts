export type JsonPrimitive = boolean | null | number | string;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type Environment = Readonly<Record<string, string | undefined>>;

export interface ShimConfig {
  readonly host: string;
  readonly port: number;
  readonly cwd: string;
  readonly agentDir: string | undefined;
  readonly sessionDir: string | undefined;
  readonly providerId: string;
  readonly modelId: string;
  readonly version: string;
}

export interface ProviderModel {
  readonly id: string;
  readonly name: string;
}

export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly models: readonly ProviderModel[];
}

export interface HealthResponse {
  readonly healthy: true;
  readonly service: "pi-opencode-server";
  readonly version: string;
}

export interface ProviderResponse {
  readonly default: string;
  readonly providers: readonly Provider[];
}

export type SessionStatus = "aborted" | "error" | "idle" | "running";

export type FacadePart =
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  | { readonly type: "reasoning"; readonly text: string }
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly input: JsonValue;
      readonly name: string;
    }
  | {
      readonly type: "tool-result";
      readonly error: boolean;
      readonly text: string;
      readonly toolCallId: string;
    };

export interface FacadeMessage {
  readonly id: string;
  readonly role: "assistant" | "tool" | "user";
  readonly time: {
    readonly completed?: number;
    readonly created: number;
  };
  readonly parts: readonly FacadePart[];
}

export interface SessionSnapshot {
  readonly id: string;
  readonly cwd: string;
  readonly messages: readonly FacadeMessage[];
  readonly status: SessionStatus;
  readonly time: {
    readonly created: number;
    readonly updated: number;
  };
}

export interface ErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
