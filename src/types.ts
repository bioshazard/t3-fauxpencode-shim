export type JsonPrimitive = boolean | null | number | string;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type Environment = Readonly<Record<string, string | undefined>>;

export interface ShimConfig {
  readonly allowedRoots?: readonly string[];
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
  readonly providerID?: string;
  readonly name: string;
  readonly api?: {
    readonly id: string;
    readonly npm: string;
    readonly url: string;
  };
  readonly capabilities?: {
    readonly attachment: boolean;
    readonly input: Readonly<Record<string, boolean>>;
    readonly interleaved: boolean | { readonly field: string };
    readonly output: Readonly<Record<string, boolean>>;
    readonly reasoning: boolean;
    readonly temperature: boolean;
    readonly toolcall: boolean;
  };
  readonly cost?: {
    readonly cache: { readonly read: number; readonly write: number };
    readonly input: number;
    readonly output: number;
  };
  readonly limit?: {
    readonly context: number;
    readonly output: number;
  };
  readonly options?: Readonly<Record<string, JsonValue>>;
  readonly status?: "alpha" | "beta" | "deprecated" | "active";
  readonly headers?: Readonly<Record<string, string>>;
  readonly release_date?: string;
}

export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly source: "env" | "config" | "custom" | "api";
  readonly env: readonly string[];
  readonly options: Readonly<Record<string, JsonValue>>;
  readonly models: Readonly<Record<string, ProviderModel>>;
}

export interface PromptImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface PromptInput {
  readonly text: string;
  readonly images: readonly PromptImage[];
  readonly messageId?: string;
  readonly model?: {
    readonly providerId: string;
    readonly modelId: string;
  };
  readonly agent?: string;
  readonly variant?: string;
}

export interface HealthResponse {
  readonly healthy: true;
  readonly service: "pi-opencode-server";
  readonly version: string;
}

export interface ProviderResponse {
  readonly all: readonly Provider[];
  readonly connected: readonly string[];
  readonly default: Readonly<Record<string, string>>;
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
  readonly permission: readonly JsonValue[];
  readonly title: string;
  readonly status: SessionStatus;
  readonly time: {
    readonly created: number;
    readonly updated: number;
  };
}

export interface EventProperties {
  readonly delta?: string;
  readonly error?: string;
  readonly info?: OpenCodeMessageInfo;
  readonly isError?: boolean;
  readonly message?: FacadeMessage;
  readonly messageId?: string;
  readonly part?: OpenCodeTextPart;
  readonly sessionID?: string;
  readonly sessionStatus?: SessionStatus;
  readonly status?: OpenCodeSessionStatus;
  readonly time?: number;
  readonly toolCallId?: string;
  readonly toolName?: string;
}

export interface OpenCodeMessageInfo {
  readonly agent: string;
  readonly cost?: number;
  readonly finish?: string;
  readonly id: string;
  readonly mode?: string;
  readonly model?: {
    readonly modelID: string;
    readonly providerID: string;
  };
  readonly modelID?: string;
  readonly parentID?: string;
  readonly path?: {
    readonly cwd: string;
    readonly root: string;
  };
  readonly providerID?: string;
  readonly role: "assistant" | "user";
  readonly sessionID: string;
  readonly time: {
    readonly completed?: number;
    readonly created: number;
  };
  readonly tokens?: {
    readonly cache: { readonly read: number; readonly write: number };
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
  };
}

export interface OpenCodeTextPart {
  readonly id: string;
  readonly messageID: string;
  readonly sessionID: string;
  readonly text: string;
  readonly time: { readonly end?: number; readonly start: number };
  readonly type: "text" | "reasoning";
}

export type OpenCodeSessionStatus =
  | { readonly type: "busy" }
  | { readonly type: "idle" };

export interface FacadeEvent {
  readonly id: string;
  readonly properties: EventProperties;
  readonly sessionID: string;
  readonly type: string;
}

export type SessionEventSink = (event: FacadeEvent) => void;

export interface ErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
