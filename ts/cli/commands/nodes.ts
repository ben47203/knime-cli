import { byAlias, byFactory, CATALOGUE, search, type CatalogueEntry } from "../catalogue.ts";
import { arg, type Command } from "../cli.ts";
import { CliError, EXIT } from "../errors.ts";
import { presetsFor } from "../presets.ts";

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
  summary: "Known settings keys, presets, gotchas and image output of a catalogue node",
  args: "<alias|factory>",
  notes: ["Ports aren't listed here: `knime node ports <node>` reads them, with their columns, from KNIME."],
  examples: ["knime nodes info rf-learn", "knime nodes info partition --json"],
  async run(ctx) {
    const q = arg(ctx, 0, "alias");
    const e = byAlias(q) ?? byFactory(q);
    if (!e) {
      const near = search(q.replace(/[-_]/g, " ")).slice(0, 5).map((x) => x.alias);
      throw new CliError({ code: "ALIAS_NOT_FOUND", exit: EXIT.NOT_FOUND, message: `No catalogue entry "${q}"`, hint: near.length ? `Did you mean: ${near.join(", ")}?` : "See `knime nodes search`." });
    }
    const presets = presetsFor(e.alias).map((p) => ({
      name: p.name, desc: p.desc, params: p.params, example: p.example, settings: p.build(p.example),
    }));
    return {
      data: { ...e, presets },
      text: [
        `${e.name} — ${e.alias}${e.verified ? "" : " (unverified)"}`,
        `factory: ${e.factory}`,
        ...(e.deprecated ? [`deprecated: ${e.deprecated}`] : []),
        "ports: from KNIME, once the node is placed: `knime node ports <node>` (0 is the flow-variable port)",
        "settings keys:", ...(Object.keys(e.keys).length ? Object.entries(e.keys).map(([k, v]) => `  ${k}: ${v}`) : ["  (none recorded; read them with `knime node settings`)"]),
        ...(e.image ? [
          "image output: this node can put its chart on an image output port. In one command:",
          `  knime node image <node> --enable [-o chart.png | -o chart.svg] [--width W --height H]`,
          "  sets generateImage (and format and size), adds the Output Image port if missing, runs the node and writes the file.",
        ] : []),
        ...(e.gotchas.length ? ["gotchas:", ...e.gotchas.map((g) => `  - ${g}`)] : []),
        ...presets.flatMap((p) => [
          `preset "${p.name}": ${p.desc}`,
          ...Object.entries(p.params).map(([k, v]) => `  ${k}${v.required ? " (required)" : ""} [${v.kind}]: ${v.desc}`),
          `  e.g. in an apply spec: "preset": ${JSON.stringify({ name: p.name, ...p.example })}`,
          `  which sends this patch (settings in the spec override single keys):`,
          ...JSON.stringify(p.settings, null, 2).split("\n").map((l) => `    ${l}`),
        ]),
      ],
    };
  },
};
