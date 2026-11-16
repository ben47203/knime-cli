import type { Command } from "../cli.ts";
import { usage } from "../errors.ts";
import { findTopic, loadTopics } from "../guide.ts";

export const guide: Command = {
  path: ["guide"],
  tier: "LOCAL",
  summary: "Short topics on KNIME and this API: start here if you have no context",
  args: "[topic]",
  options: { all: { type: "boolean", desc: "Print every topic" } },
  notes: ["Topics: start, connecting, model, settings, execution, errors, data, recipes, apply, design."],
  examples: ["knime guide", "knime guide settings", "knime guide --all --json"],
  async run(ctx) {
    const topics = loadTopics();
    const name = ctx.positionals[0];
    if (ctx.values.all) {
      return { data: { topics }, text: topics.flatMap((t) => [`# ${t.title} (${t.id})`, "", t.body, ""]) };
    }
    if (!name) {
      const start = findTopic(topics, "start")!;
      return {
        data: { topics: topics.map((t) => ({ id: t.id, title: t.title })), start: start.body },
        text: [
          start.body, "",
          "Topics (`knime guide <topic>`):",
          ...topics.map((t) => `  ${t.id.padEnd(12)} ${t.title}`),
        ],
      };
    }
    const t = findTopic(topics, name);
    if (!t) throw usage(`No guide topic "${name}"`, `Topics: ${topics.map((x) => x.id).join(", ")}`);
    return { data: t, text: [`# ${t.title}`, "", t.body] };
  },
};
