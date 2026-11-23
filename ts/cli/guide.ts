/** `knime guide`: topics from CONTEXT.md (`## Title {#topic}` sections), plus the generated error table. */
import { readFileSync } from "node:fs";

import { CLI_ERRORS, TRANSLATIONS } from "./errors.ts";

export interface Topic {
  id: string;
  title: string;
  body: string;
}

const CONTEXT = new URL("./CONTEXT.md", import.meta.url);

export function parseTopics(markdown: string): Topic[] {
  const topics: Topic[] = [];
  let cur: Topic | undefined;
  for (const line of markdown.split("\n")) {
    const m = /^## (.+?) \{#([\w-]+)\}\s*$/.exec(line);
    if (m) {
      cur = { id: m[2]!, title: m[1]!, body: "" };
      topics.push(cur);
    } else if (/^## /.test(line)) {
      cur = undefined;
    } else if (cur) {
      cur.body += `${line}\n`;
    }
  }
  for (const t of topics) t.body = t.body.trim();
  return topics;
}

export function loadTopics(): Topic[] {
  const topics = parseTopics(readFileSync(CONTEXT, "utf8"));
  const errors = topics.find((t) => t.id === "errors");
  if (errors) errors.body += `\n\n${errorTable()}`;
  return topics;
}

export function errorTable(): string {
  const rows = [
    ...TRANSLATIONS.map((t) => ({ ...t, from: t.status === "rpc" ? "gateway" : t.status === "net" ? "network" : `HTTP ${t.status}` })),
    ...CLI_ERRORS.map((t) => ({ ...t, from: "CLI" })),
  ];
  return rows.map((r) => `- **${r.code}** (exit ${r.exit}, ${r.from}): ${r.cause}\n  Next: ${r.hint}`).join("\n");
}

/** Aliases so agents can guess topic names. */
const ALIASES: Record<string, string> = {
  quickstart: "start", "quick-start": "start", intro: "start",
  connect: "connecting", discovery: "connecting", status: "connecting",
  concepts: "model", ports: "model", ids: "model", labels: "model",
  set: "settings", patch: "settings",
  run: "execution", execute: "execution",
  error: "errors", "exit-codes": "errors",
  recipe: "recipes", nodes: "recipes",
  pipeline: "apply", spec: "apply",
  io: "data", output: "data",
  save: "saving", dirty: "saving", unsaved: "saving",
  svg: "images", png: "images", image: "images", canvas: "images", chart: "images", charts: "images",
  annotate: "annotations", annotation: "annotations", notes: "annotations", note: "annotations", colours: "annotations", colors: "annotations",
};

export function findTopic(topics: readonly Topic[], name: string): Topic | undefined {
  const id = ALIASES[name.toLowerCase()] ?? name.toLowerCase();
  return topics.find((t) => t.id === id);
}
