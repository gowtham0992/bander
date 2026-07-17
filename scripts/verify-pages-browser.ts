import fs from "node:fs";

const endpoint = process.env.BANDER_CDP_ENDPOINT ?? "http://127.0.0.1:9333";
const pages = await fetch(`${endpoint}/json/list`).then((response) => response.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
const target = pages.find((page) => page.type === "page" && page.url.includes("/bander/"));
if (!target) throw new Error("No Bander Pages tab is available for browser QA");

let nextId = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
const requests: string[] = [];
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("Could not connect to the browser QA tab")), { once: true });
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: { request?: { url?: string } }; result?: unknown; error?: { message: string } };
  if (message.method === "Network.requestWillBeSent" && message.params?.request?.url) requests.push(message.params.request.url);
  if (message.id === undefined) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});

function command<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (value) => resolve(value as T), reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate<T>(expression: string): Promise<T> {
  const result = await command<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result.result.value;
}

async function waitFor(expression: string, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await evaluate<boolean>(expression)) return true;
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  return false;
}

async function key(key: string, code: string, keyCode: number): Promise<void> {
  const text = key === "Enter" ? "\r" : key === " " ? " " : undefined;
  await command("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, ...(text ? { text, unmodifiedText: text } : {}) });
  await command("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
}

async function reload(): Promise<void> {
  await command("Page.reload", { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 120));
}

try {
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Network.enable");
  await command("Accessibility.enable");
  requests.length = 0;
  await reload();

  const ax = await command<{ nodes: Array<{ role?: { value?: string }; name?: { value?: string } }> }>("Accessibility.getFullAXTree");
  const buttons = ax.nodes.filter((node) => node.role?.value === "button");
  const headings = ax.nodes.filter((node) => node.role?.value === "heading");
  const mainHeading = headings.filter((node) => node.name?.value === "Ask freely. Approve changes.");
  if (mainHeading.length !== 1) throw new Error("The Pages accessibility tree does not contain one clear product heading");
  if (buttons.some((node) => !node.name?.value?.trim())) throw new Error("The Pages accessibility tree contains an unnamed button");
  for (const phrase of ["JUST ASK", "APPROVE A CHANGE", "WHEN BANDER ISN’T SURE"]) {
    if (!buttons.some((node) => node.name?.value?.includes(phrase))) throw new Error(`The Pages accessibility tree is missing the ${phrase} lane name`);
  }
  if (!(await evaluate<boolean>(`document.body.textContent.includes("Bander can also stop when the world changed—or admit when a result cannot be confirmed. Explore those cases below.")`))) {
    throw new Error("The Pages episode does not route evaluators to the changed-world and uncertain cases");
  }
  const repositoryStyle = await evaluate<{ background: string; foreground: string }>(`(()=>{const link=document.querySelector(".project-links .repository-link");const style=link?getComputedStyle(link):null;return{background:style?.backgroundColor??"",foreground:style?.color??""}})()`);
  if (!repositoryStyle.background || repositoryStyle.background === "rgba(0, 0, 0, 0)" || repositoryStyle.background === repositoryStyle.foreground) {
    throw new Error("The repository is not the visually primary footer destination");
  }

  const origin = new URL(target.url).origin;
  const externalRequests = requests.filter((url) => new URL(url).origin !== origin);
  if (externalRequests.length > 0) throw new Error("The Pages runtime made an external network request");

  await key("Tab", "Tab", 9);
  await key("Tab", "Tab", 9);
  const focusedRead = await evaluate<{ text: string; outline: string }>(`({text:document.activeElement?.textContent?.replace(/\\s+/g," ").trim()??"",outline:getComputedStyle(document.activeElement).outlineStyle})`);
  if (!focusedRead.text.includes("JUST ASK") || focusedRead.outline === "none") throw new Error("The first lane is not visibly keyboard focusable");
  await key("Enter", "Enter", 13);
  if (!(await waitFor(`document.body.textContent.includes("Here’s tomorrow.")`))) throw new Error("Enter did not activate the native read-lane button");

  await reload();
  for (let index = 0; index < 4; index += 1) await key("Tab", "Tab", 9);
  await key(" ", "Space", 32);
  if (!(await waitFor(`document.body.textContent.includes("Sandbox scenario")`))) throw new Error("Space did not activate the native uncertainty-lane button");

  await command("Page.navigate", { url: `${origin}/bander/?scenario=compound` });
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (!(await evaluate<boolean>(`document.body.textContent.includes("Through Bander, this will:") && !document.body.textContent.includes("Draft not found")`))) {
    throw new Error("The compound deep link did not initialize into a safe Card");
  }
  await evaluate(`(()=>{const button=document.querySelector(".deal-card .primary");button?.click();button?.click();return true})()`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const doubleApproval = await evaluate<{ draftError: boolean; familyUpdates: number; replayControl: boolean }>(`({draftError:document.body.textContent.includes("Draft not found"),familyUpdates:document.querySelectorAll(".sandbox-phone article").length,replayControl:document.body.textContent.includes("Replay the same approval")})`);
  if (doubleApproval.draftError || doubleApproval.familyUpdates !== 1 || !doubleApproval.replayControl) throw new Error("Deep-link double approval was not single-flight and replay-safe");

  await command("Page.navigate", { url: `${origin}/bander/` });
  await new Promise((resolve) => setTimeout(resolve, 120));

  for (const [width, height] of [[1440, 900], [1280, 720], [500, 900], [375, 812]] as const) {
    await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await reload();
    const metrics = await evaluate<{ width: number; scrollWidth: number; minTarget: number; nested: number }>(`(()=>{const buttons=[...document.querySelectorAll("button")];return{width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,minTarget:Math.min(...buttons.map(button=>Math.min(button.getBoundingClientRect().width,button.getBoundingClientRect().height))),nested:document.querySelectorAll("button button, button a, a button, a a").length}})()`);
    if (metrics.scrollWidth > metrics.width) throw new Error(`Horizontal overflow at ${width}×${height}`);
    if (metrics.minTarget < 44) throw new Error(`A mobile target is under 44px at ${width}×${height}`);
    if (metrics.nested !== 0) throw new Error("The Pages surface contains nested interactive controls");
    const screenshot = await command<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(`/private/tmp/bander-pages-${width}x${height}.png`, Buffer.from(screenshot.data, "base64"), { mode: 0o600 });
  }

  console.log(`Pages browser QA verified: ${buttons.length} named buttons, one main heading, keyboard Enter/Space, deep-link single-flight approval, zero external requests, and 1440×900 / 1280×720 / 500×900 / 375×812 layouts.`);
} finally {
  socket.close();
}
