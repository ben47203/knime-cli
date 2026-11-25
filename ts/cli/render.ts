/**
 * SVG → PNG through a headless browser. KNIME's canvas SVG draws its text in foreignObject, which only a browser
 * renders faithfully, and the CLI keeps zero runtime dependencies, so it shells out to one that's already installed:
 * KNIME_CLI_BROWSER, else Chrome/Chromium/Edge, else a browser Playwright has downloaded, else the `playwright` CLI.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { CliError, EXIT } from "./errors.ts";

const run = promisify(execFile);

export interface Browser {
  /** chrome: any Chromium-based binary taking `--headless --screenshot`; playwright: the `playwright` CLI. */
  kind: "chrome" | "playwright";
  path: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(PNG_SIGNATURE);
}

function onPath(names: string[], env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const n of names) {
      const p = join(dir, n);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/** Chromium builds Playwright has downloaded (`npx playwright install`), newest first. */
function playwrightChromes(env: NodeJS.ProcessEnv): string[] {
  const root = env.PLAYWRIGHT_BROWSERS_PATH
    ?? (platform() === "darwin" ? join(homedir(), "Library", "Caches", "ms-playwright")
      : platform() === "win32" ? join(env.LOCALAPPDATA ?? homedir(), "ms-playwright") : join(homedir(), ".cache", "ms-playwright"));
  let dirs: string[];
  try {
    dirs = readdirSync(root).filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d)).sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()));
  } catch {
    return [];
  }
  const inside = [
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
    "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/headless_shell", "chrome-mac-arm64/headless_shell", "chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "chrome-headless-shell-mac-x64/chrome-headless-shell", "chrome-linux/chrome", "chrome-linux64/chrome", "chrome-linux/headless_shell",
    "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-win/chrome.exe", "chrome-win64/chrome.exe",
  ];
  return dirs.flatMap((d) => inside.map((i) => join(root, d, i))).filter((p) => existsSync(p));
}

/** The first usable browser, or undefined. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): Browser | undefined {
  if (env.KNIME_CLI_BROWSER) {
    return { kind: /playwright/i.test(env.KNIME_CLI_BROWSER) ? "playwright" : "chrome", path: env.KNIME_CLI_BROWSER };
  }
  const apps = platform() === "darwin"
    ? ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser"].map((a) => `/Applications/${a}.app/Contents/MacOS/${a}`)
    : platform() === "win32"
      ? [join(env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        join(env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe")]
      : [];
  const chrome = apps.find((p) => existsSync(p))
    ?? onPath(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"], env)
    ?? playwrightChromes(env)[0];
  if (chrome) return { kind: "chrome", path: chrome };
  const pw = onPath(["playwright"], env);
  return pw ? { kind: "playwright", path: pw } : undefined;
}

export const NO_BROWSER_HINT = "Install Google Chrome or Chromium, or run `npx playwright install chromium`, or point "
  + "KNIME_CLI_BROWSER at a Chromium-based browser. The SVG itself needs none: drop --png.";

/** The root element's width and height, rounded up; undefined if it has none. */
export function svgSize(svg: string): { width: number; height: number } | undefined {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) return undefined;
  const attr = (n: string) => Number.parseFloat(new RegExp(`\\s${n}="([\\d.]+)(px)?"`).exec(root)?.[1] ?? "");
  let width = attr("width");
  let height = attr("height");
  if (!(width > 0 && height > 0)) {
    const vb = /\sviewBox="([^"]+)"/.exec(root)?.[1]?.trim().split(/[\s,]+/).map(Number);
    if (!vb || vb.length !== 4) return undefined;
    [width, height] = [vb[2]!, vb[3]!];
  }
  return width > 0 && height > 0 ? { width: Math.ceil(width), height: Math.ceil(height) } : undefined;
}

/** Renders `svg` to PNG bytes at `scale` × its own size. */
export async function svgToPng(svg: string, opts: { scale?: number; browser?: Browser } = {}): Promise<Buffer> {
  const browser = opts.browser ?? findBrowser();
  if (!browser) {
    throw new CliError({ code: "NO_BROWSER", exit: EXIT.UNAVAILABLE, message: "--png needs a headless browser, and none was found", hint: NO_BROWSER_HINT });
  }
  const size = svgSize(svg) ?? { width: 1200, height: 800 };
  const scale = opts.scale ?? 1;
  const dir = await mkdtemp(join(tmpdir(), "knime-cli-png-"));
  try {
    const src = join(dir, "canvas.svg");
    const out = join(dir, "canvas.png");
    await writeFile(src, svg);
    const url = pathToFileURL(src).href;
    const args = browser.kind === "chrome"
      ? ["--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--mute-audio",
        `--user-data-dir=${join(dir, "profile")}`, `--force-device-scale-factor=${scale}`,
        `--window-size=${size.width},${size.height}`, `--screenshot=${out}`, url]
      : ["screenshot", `--viewport-size=${size.width},${size.height}`, url, out];
    try {
      await run(browser.path, args, { timeout: 60_000 });
    } catch (e) {
      // Chrome often exits non-zero after writing the screenshot; only a missing file is a failure.
      if (!existsSync(out)) {
        throw new CliError({
          code: "RENDER_FAILED", exit: EXIT.ERROR, message: `${browser.path} didn't render the SVG: ${(e as Error).message.split("\n")[0]}`,
          hint: `${NO_BROWSER_HINT} Or write the SVG (-o canvas.svg) and open it in a browser.`,
        });
      }
    }
    const png = await readFile(out);
    if (!isPng(png)) throw new CliError({ code: "RENDER_FAILED", exit: EXIT.ERROR, message: `${browser.path} wrote something that isn't a PNG` });
    return png;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
