import type { JsonValue } from "../../src/types.ts";

interface SourceRef {
  readonly line: number;
  readonly path: string;
  readonly repository: string;
  readonly symbol: string;
}

interface InventoryEntry {
  readonly category: string;
  readonly eventTypes?: readonly string[];
  readonly id: string;
  readonly method: string;
  readonly notes?: string;
  readonly operation: string;
  readonly path: string | null;
  readonly requestFields?: readonly string[];
  readonly sources: readonly SourceRef[];
  readonly support: "conditional" | "excluded" | "required";
  readonly transport: "http" | "process" | "sse";
}

interface Inventory {
  readonly corpusId: string;
  readonly entries: readonly InventoryEntry[];
  readonly generatedFrom: {
    readonly openCodeCommit: string;
    readonly t3CodeCommit: string;
  };
  readonly schemaVersion: 1;
}

const inventoryPath = new URL(
  "../../contracts/inventory.json",
  import.meta.url
);
const markdownPath = new URL("../../docs/inventory.md", import.meta.url);

function isRecord(
  value: JsonValue
): value is { readonly [key: string]: JsonValue } {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]";
}

function asInventory(value: JsonValue): Inventory {
  if (!isRecord(value)) throw new Error("Inventory must be a JSON object.");
  const entries = value.entries;
  if (
    value.schemaVersion !== 1 ||
    !isString(value.corpusId) ||
    !Array.isArray(entries)
  ) {
    throw new Error("Inventory has an invalid header.");
  }
  if (entries.length === 0) throw new Error("Inventory must contain entries.");
  const generatedFrom = value.generatedFrom;
  if (!isRecord(generatedFrom))
    throw new Error("Inventory is missing generatedFrom.");
  if (
    !isString(generatedFrom.t3CodeCommit) ||
    !isString(generatedFrom.openCodeCommit)
  ) {
    throw new Error("Inventory commits must be strings.");
  }
  const parsedEntries = entries.map((entry, index) => {
    if (!isRecord(entry))
      throw new Error(`Inventory entry ${index} is not an object.`);
    const required = [
      "id",
      "category",
      "operation",
      "transport",
      "method",
      "support",
      "sources",
    ];
    if (required.some((key) => !isString(entry[key]) && key !== "sources")) {
      throw new Error(`Inventory entry ${index} is missing required fields.`);
    }
    if (!Array.isArray(entry.sources) || entry.sources.length === 0) {
      throw new Error(`Inventory entry ${index} needs a source reference.`);
    }
    for (const source of entry.sources) {
      if (
        !isRecord(source) ||
        !isString(source.repository) ||
        !isString(source.path) ||
        !isNumber(source.line) ||
        !isString(source.symbol)
      ) {
        throw new Error(
          `Inventory entry ${index} has an invalid source reference.`
        );
      }
    }
    return entry as unknown as InventoryEntry;
  });
  const ids = new Set<string>();
  for (const entry of parsedEntries) {
    if (ids.has(entry.id))
      throw new Error(`Duplicate inventory id: ${entry.id}`);
    ids.add(entry.id);
  }
  return {
    corpusId: value.corpusId,
    entries: parsedEntries,
    generatedFrom: {
      openCodeCommit: generatedFrom.openCodeCommit,
      t3CodeCommit: generatedFrom.t3CodeCommit,
    },
    schemaVersion: 1,
  };
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderMarkdown(inventory: Inventory): string {
  const lines = [
    "# Static OpenCode inventory",
    "",
    `Corpus: \`${inventory.corpusId}\``,
    "",
    `Pinned T3: \`${inventory.generatedFrom.t3CodeCommit}\`  `,
    `Pinned OpenCode: \`${inventory.generatedFrom.openCodeCommit}\``,
    "",
    "Generated from `contracts/inventory.json`; edit the JSON, then run `bun run contract:inventory`.\n",
    "| ID | Operation | Transport | Method | Path | Support | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const entry of inventory.entries) {
    const evidence = entry.sources
      .map((source) => `${source.path}:${source.line} (${source.symbol})`)
      .join("<br>");
    lines.push(
      `| ${cell(entry.id)} | ${cell(entry.operation)} | ${entry.transport} | ${entry.method} | ${entry.path === null ? "—" : `\`${cell(entry.path)}\``} | ${entry.support} | ${cell(evidence)} |`
    );
  }
  const eventEntry = inventory.entries.find(
    (entry) => entry.eventTypes !== undefined
  );
  if (eventEntry?.eventTypes !== undefined) {
    lines.push(
      "",
      "## Event discriminators",
      "",
      ...eventEntry.eventTypes.map((event) => `- \`${event}\``)
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function loadInventory(): Promise<Inventory> {
  return asInventory((await Bun.file(inventoryPath).json()) as JsonValue);
}

export async function validateInventory(): Promise<void> {
  await loadInventory();
}

if (import.meta.main) {
  const inventory = await loadInventory();
  await Bun.write(markdownPath, renderMarkdown(inventory));
  console.log(`validated ${inventory.entries.length} inventory entries`);
  console.log(`wrote ${markdownPath.pathname}`);
}
