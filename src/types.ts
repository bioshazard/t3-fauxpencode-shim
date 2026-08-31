export type JsonPrimitive = boolean | null | number | string;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export type Environment = Readonly<Record<string, string | undefined>>;

export interface ShimConfig {
  readonly host: string;
  readonly port: number;
  readonly cwd: string;
  readonly agentDir: string | undefined;
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

export interface ErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
