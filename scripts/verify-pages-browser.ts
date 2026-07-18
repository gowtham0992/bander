import fs from "node:fs";

const axeSource = fs.readFileSync(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");

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

async function clickButton(label: string): Promise<void> {
  const clicked = await evaluate<boolean>(
    `(()=>{const button=[...document.querySelectorAll("button")].find(candidate=>candidate.textContent?.replace(/\\s+/g," ").trim()===${JSON.stringify(label)});if(!button)return false;button.click();return true})()`,
  );
  if (!clicked) throw new Error(`Could not find the “${label}” button during guided Pages QA`);
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
  for (const name of ["Just ask", "Approve a change", "When Bander isn’t sure"]) {
    if (!buttons.some((node) => node.name?.value === name)) {
      const observed = buttons.map((node) => node.name?.value ?? "<unnamed>");
      throw new Error(`The Pages accessibility tree is missing the exact “${name}” lane name; observed ${JSON.stringify(observed)}`);
    }
  }
  await evaluate(`(()=>{${axeSource};return true})()`);
  const axeViolations = await evaluate<Array<{ id: string; impact: string | null; nodes: number }>>(
    `globalThis.axe.run(document, {runOnly:{type:"rule",values:["button-name","link-name","nested-interactive","aria-allowed-attr","heading-order"]}}).then(result => result.violations.map(violation => ({id:violation.id,impact:violation.impact,nodes:violation.nodes.length})))`,
  );
  if (axeViolations.length > 0) throw new Error(`axe found primary-lane accessibility violations: ${JSON.stringify(axeViolations)}`);
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

  let focusedRead = { name: null as string | null, outline: "none" };
  const tabOrder: string[] = [];
  for (let index = 0; index < 24 && focusedRead.name !== "Just ask"; index += 1) {
    await key("Tab", "Tab", 9);
    focusedRead = await evaluate<{ name: string | null; outline: string }>(`({name:document.activeElement?.getAttribute("aria-label")??document.activeElement?.textContent?.replace(/\\s+/g," ").trim()??null,outline:getComputedStyle(document.activeElement).outlineStyle})`);
    if (focusedRead.name) tabOrder.push(focusedRead.name);
  }
  if (focusedRead.name !== "Just ask" || focusedRead.outline === "none") throw new Error("The first lane is not visibly keyboard focusable under its explicit accessible name");
  const laneOrder = tabOrder.filter((name) => ["Just ask", "Approve a change", "When Bander isn’t sure"].includes(name));
  if (laneOrder[0] !== "Just ask") throw new Error(`The primary lanes are not in a logical keyboard order: ${JSON.stringify(laneOrder)}`);
  await key("Enter", "Enter", 13);
  if (!(await waitFor(`document.body.textContent.includes("Here’s tomorrow.")`))) throw new Error("Enter did not activate the native read-lane button");

  await reload();
  let uncertainFocused = false;
  for (let index = 0; index < 26 && !uncertainFocused; index += 1) {
    await key("Tab", "Tab", 9);
    uncertainFocused = await evaluate<boolean>(`document.activeElement?.getAttribute("aria-label")==="When Bander isn’t sure"`);
  }
  if (!uncertainFocused) throw new Error("The uncertainty lane was not reachable in keyboard order");
  await key(" ", "Space", 32);
  if (!(await waitFor(`document.body.textContent.includes("Sandbox scenario")`))) throw new Error("Space did not activate the native uncertainty-lane button");

  await command("Page.navigate", { url: `${origin}/bander/?scenario=compound` });
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (!(await evaluate<boolean>(`document.body.textContent.includes("If you say yes, Bander will check the latest information") && !document.body.textContent.includes("Draft not found")`))) {
    throw new Error("The compound deep link did not initialize into a safe Card");
  }
  await evaluate(`(()=>{const button=document.querySelector(".deal-card .primary");button?.click();button?.click();return true})()`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const doubleApproval = await evaluate<{ draftError: boolean; familyUpdates: number; replayControl: boolean }>(`({draftError:document.body.textContent.includes("Draft not found"),familyUpdates:document.querySelectorAll(".sandbox-phone article").length,replayControl:document.body.textContent.includes("Replay the same approval")})`);
  if (doubleApproval.draftError || doubleApproval.familyUpdates !== 1 || !doubleApproval.replayControl) throw new Error("Deep-link double approval was not single-flight and replay-safe");

  await command("Page.navigate", { url: `${origin}/bander/` });
  await new Promise((resolve) => setTimeout(resolve, 120));

  await clickButton("Ask without approval");
  if (!(await waitFor(`document.body.textContent.includes("Prepare the exact reply")`))) throw new Error("The guided read step did not complete");
  await clickButton("Prepare the exact reply");
  if (!(await waitFor(`document.body.textContent.includes("Do exactly this")`))) throw new Error("The guided email Card did not appear");
  await clickButton("Do exactly this");
  if (!(await waitFor(`document.body.textContent.includes("Prepare the calendar + family deal")`))) throw new Error("The guided email approval did not complete");
  await clickButton("Prepare the calendar + family deal");
  if (!(await waitFor(`document.body.textContent.includes("Do exactly this")`))) throw new Error("The guided Calendar Card did not appear");
  await clickButton("Do exactly this");
  if (!(await waitFor(`document.body.textContent.includes("See how this works for real →")`))) throw new Error("The guided final real-evidence link did not appear");
  const guidedLink = await evaluate<{ text: string; href: string }>(`(()=>{const link=document.querySelector(".evidence-strip .real-services-link");return{text:link?.textContent?.trim()??"",href:link?.getAttribute("href")??""}})()`);
  if (guidedLink.text !== "See how this works for real →" || guidedLink.href !== "https://github.com/gowtham0992/bander#real-services-and-evidence") {
    throw new Error(`The guided final real-evidence link is incorrect: ${JSON.stringify(guidedLink)}`);
  }

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

  console.log(`Pages browser QA verified: ${buttons.length} named buttons, three exact lane names, page-wide scoped axe checks with zero violations, one main heading, keyboard Enter/Space, guided final real-evidence link, deep-link single-flight approval, zero external requests, and 1440×900 / 1280×720 / 500×900 / 375×812 layouts.`);
} finally {
  socket.close();
}
