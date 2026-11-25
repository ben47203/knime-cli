import { byAlias, byFactory, CATALOGUE, search, type CatalogueEntry } from "../catalogue.ts";
import { arg, type Command } from "../cli.ts";
import { CliError, EXIT } from "../errors.ts";

const brief = (e: CatalogueEntry) => ({ alias: e.alias, name: e.name, category: e.category, factory: e.factory, verified: e.verified, deprecated: e.deprecated });

export const nodesSearch: Command = {
  path: ["nodes", "search"],
  tier: "LOCAL",
  summary: "Search the built-in catalogue of known-good nodes by alias, name or tag",
  args: "[text]",
  notes: [
    "The catalogue covers the nodes verified in dogfooding runs (see `knime guide recipes`). Other nodes work too:",
    "pass their factory class name to `node add`. Whether a node exists depends on the running KNIME's extensions.",
  ],
  examples: ["knime nodes search regression", "knime nodes search --json"],
  async run(ctx) {
    const text = ctx.positionals.join(" ");
    const hits = text ? search(text) : [...CATALOGUE];
    return {
      data: { query: text, results: hits.map(brief) },
      text: hits.length
        ? hits.map((e) => `${e.alias.padEnd(18)} ${e.name.padEnd(44)} ${e.category}${e.verified ? "" : " (unverified)"}${e.deprecated ? " (deprecated)" : ""}`)
        : [`no catalogue entries match "${text}"; try \`knime nodes search\` for the full list`],
    };
  },
};

export const nodesInfo: Command = {
  path: ["nodes", "info"],
  tier: "LOCAL",
  summary: "Ports, known settings keys and gotchas of a catalogue node",
  args: "<alias|factory>",
  examples: ["knime nodes info rf-learn", "knime nodes info partition --json"],
  async run(ctx) {
    const q = arg(ctx, 0, "alias");
    const e = byAlias(q) ?? byFactory(q);
    if (!e) {
      const near = search(q.replace(/[-_]/g, " ")).slice(0, 5).map((x) => x.alias);
      throw new CliError({ code: "ALIAS_NOT_FOUND", exit: EXIT.NOT_FOUND, message: `No catalogue entry "${q}"`, hint: near.length ? `Did you mean: ${near.join(", ")}?` : "See `knime nodes search`." });
    }
    const port = (p: { index: number; name: string; type: string }) => `  ${p.index}: ${p.name} (${p.type})`;
    return {
      data: e,
      text: [
        `${e.name} — ${e.alias}${e.verified ? "" : " (unverified)"}`,
        `factory: ${e.factory}`,
        ...(e.deprecated ? [`deprecated: ${e.deprecated}`] : []),
        "inputs (0 is the flow-variable port):", ...(e.in.length ? e.in.map(port) : ["  none"]),
        "outputs:", ...(e.out.length ? e.out.map(port) : ["  none"]),
        "settings keys:", ...(Object.keys(e.keys).length ? Object.entries(e.keys).map(([k, v]) => `  ${k}: ${v}`) : ["  (none recorded; read them with `knime node settings`)"]),
        ...(e.gotchas.length ? ["gotchas:", ...e.gotchas.map((g) => `  - ${g}`)] : []),
      ],
    };
  },
};
