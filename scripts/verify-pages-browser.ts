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
  try {
    const result = await command<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return result.result.value;
  } catch (error) {
    throw new Error(`${(error as Error).message} while evaluating ${expression.slice(0, 180)}`);
  }
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
  const mainHeading = headings.filter((node) => node.name?.value === "Bander family conversation sandbox");
  if (mainHeading.length !== 1) throw new Error("The Pages accessibility tree does not contain one clear product heading");
  if (buttons.some((node) => !node.name?.value?.trim())) throw new Error("The Pages accessibility tree contains an unnamed button");
  if (!buttons.some((node) => node.name?.value === "Tap to ask — you drive everything here.")) throw new Error("The Family Thread ask control is missing from the accessibility tree");
  await evaluate(`(()=>{${axeSource};return true})()`);
  const axeViolations = await evaluate<Array<{ id: string; impact: string | null; nodes: number }>>(
    `globalThis.axe.run(document, {runOnly:{type:"rule",values:["button-name","link-name","nested-interactive","aria-allowed-attr","heading-order"]}}).then(result => result.violations.map(violation => ({id:violation.id,impact:violation.impact,nodes:violation.nodes.length})))`,
  );
  if (axeViolations.length > 0) throw new Error(`axe found Family Thread accessibility violations: ${JSON.stringify(axeViolations)}`);

  const origin = new URL(target.url).origin;
  const externalRequests = requests.filter((url) => new URL(url).origin !== origin);
  if (externalRequests.length > 0) throw new Error("The Pages runtime made an external network request");
  const idle = await evaluate<{ messages: number; cards: number; activeWorld: number; oldWelcome: boolean; line: string; stage: string }>(`({messages:document.querySelectorAll(".thread-message").length,cards:document.querySelectorAll("[role=dialog]").length,activeWorld:document.querySelectorAll(".world-object[data-active]").length,oldWelcome:document.body.textContent.includes("Ask freely. Approve changes."),line:document.querySelector(".bander-line")?.getAttribute("data-line-state")??"",stage:document.querySelector(".family-thread-shell")?.className??""})`);
  if (idle.messages !== 1 || idle.cards !== 0 || idle.activeWorld !== 0 || idle.oldWelcome || idle.line !== "idle" || !idle.stage.includes("stage-idle")) throw new Error(`The Family Thread idle state is not bounded: ${JSON.stringify(idle)}`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (!(await evaluate<string>(`document.querySelector(".family-thread-shell")?.className??""`)).includes("stage-idle")) throw new Error("The Family Thread advanced without a visitor action");

  let focusedAsk = { name: null as string | null, outline: "none" };
  for (let index = 0; index < 8 && focusedAsk.name !== "Tap to ask — you drive everything here."; index += 1) {
    await key("Tab", "Tab", 9);
    focusedAsk = await evaluate<{ name: string | null; outline: string }>(`({name:document.activeElement?.getAttribute("aria-label")??document.activeElement?.textContent?.replace(/\\s+/g," ").trim()??null,outline:getComputedStyle(document.activeElement).outlineStyle})`);
  }
  if (focusedAsk.name !== "Tap to ask — you drive everything here." || focusedAsk.outline === "none") throw new Error("The Family Thread ask control is not visibly keyboard focusable");
  await key("Enter", "Enter", 13);
  if (!(await waitFor(`document.body.textContent.includes("Reading never crosses the line.")`))) throw new Error("Enter did not activate the Family Thread read");
  const readState = await evaluate<{ cards: number; activeWorld: number; line: string }>(`({cards:document.querySelectorAll("[role=dialog]").length,activeWorld:document.querySelectorAll(".world-object[data-active]").length,line:document.querySelector(".bander-line")?.getAttribute("data-line-state")??""})`);
  if (readState.cards !== 0 || readState.activeWorld !== 0 || readState.line !== "idle") throw new Error(`The harmless read crossed the Bander Line: ${JSON.stringify(readState)}`);

  await evaluate(`document.querySelector(".suggested-message")?.focus()`);
  await key(" ", "Space", 32);
  if (!(await waitFor(`document.querySelector("[role=dialog]") && document.body.textContent.includes("Do exactly this")`))) throw new Error("Space did not prepare the exact email Card");
  const cardState = await evaluate<{ modal: boolean; focus: string; inert: boolean; recipient: boolean; reply: boolean; changeButton: boolean; line: string; headingVisible: boolean }>(`(()=>{const heading=document.querySelector("[role=dialog] .deal-heading");const box=heading?.getBoundingClientRect();const style=heading?getComputedStyle(heading):null;return{modal:document.querySelector("[role=dialog]")?.getAttribute("aria-modal")==="true",focus:document.activeElement?.textContent?.trim()??"",inert:document.querySelector(".family-stage")?.hasAttribute("inert")??false,recipient:document.body.textContent.includes("office@example.test"),reply:document.body.textContent.includes("Thursday at 2 works."),changeButton:[...document.querySelectorAll("button")].some(button=>button.textContent?.trim()==="Change it"),line:document.querySelector(".bander-line")?.getAttribute("data-line-state")??"",headingVisible:Boolean(heading?.textContent?.includes("Bander hasn’t done anything yet — please check:")&&box&&box.width>0&&box.height>0&&style?.display!=="none"&&style?.visibility!=="hidden")}})()`);
  if (!cardState.modal || cardState.focus !== "Do exactly this" || !cardState.inert || !cardState.recipient || !cardState.reply || cardState.changeButton || cardState.line !== "waiting" || !cardState.headingVisible) throw new Error(`The exact Card modal is incomplete: ${JSON.stringify(cardState)}`);

  await clickButton("Not now");
  if (!(await waitFor(`document.body.textContent.includes("Your calendar and messages were left exactly as they were.")`))) throw new Error("Decline did not return the truthful no-action outcome");
  const declined = await evaluate<{ dialog: number; focus: string; activeWorld: number; line: string }>(`({dialog:document.querySelectorAll("[role=dialog]").length,focus:document.activeElement?.textContent?.replace(/\\s+/g," ").trim()??"",activeWorld:document.querySelectorAll(".world-object[data-active]").length,line:document.querySelector(".bander-line")?.getAttribute("data-line-state")??""})`);
  if (declined.dialog !== 0 || !declined.focus.includes("Reply that Thursday at 2 works.") || declined.activeWorld !== 0 || declined.line !== "idle") throw new Error(`Decline crossed the Line or lost focus: ${JSON.stringify(declined)}`);

  await evaluate(`document.querySelector(".suggested-message")?.click()`);
  if (!(await waitFor(`Boolean(document.querySelector("[role=dialog]"))`))) throw new Error("The declined deal could not be prepared again");
  await clickButton("Do exactly this");
  if (!(await waitFor(`document.body.textContent.includes("Email sent ✓") && document.body.textContent.includes("Next: add it to the calendar and let Gil know.")`))) throw new Error("The approved email outcome did not return through Bander");
  const sent = await evaluate<{ proof: number; activeInbox: boolean; phoneActive: boolean; line: string; seal: boolean; announcementFocused: boolean; announcementOutline: string }>(`(()=>{const announcement=document.querySelector(".authoritative-outcome");return{proof:document.querySelectorAll(".approved-deal-proof").length,activeInbox:document.querySelectorAll(".world-object")[1]?.hasAttribute("data-active")??false,phoneActive:document.querySelectorAll(".world-object")[2]?.hasAttribute("data-active")??false,line:document.querySelector(".bander-line")?.getAttribute("data-line-state")??"",seal:document.body.textContent.includes("Approved word-for-word"),announcementFocused:document.activeElement===announcement,announcementOutline:announcement?getComputedStyle(announcement).outlineStyle:"missing"}})()`);
  if (sent.proof !== 1 || !sent.activeInbox || sent.phoneActive || sent.line !== "crossed" || !sent.seal || !sent.announcementFocused || sent.announcementOutline !== "none") throw new Error(`Approval did not cross exactly once into seeded Sent mail without decorating announcement focus: ${JSON.stringify(sent)}`);

  await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await command("Page.navigate", { url: `${origin}/bander/` });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const reducedMotion = await evaluate<{ duration: string; stage: string }>(`({duration:getComputedStyle(document.querySelector(".thread-message")).animationDuration,stage:document.querySelector(".family-thread-shell")?.className??""})`);
  if (Number.parseFloat(reducedMotion.duration) > 0.001 || !reducedMotion.stage.includes("stage-idle")) throw new Error(`Reduced-motion mode does not retain the complete idle semantics: ${JSON.stringify(reducedMotion)}`);
  await command("Emulation.setEmulatedMedia", { features: [] });

  await command("Page.navigate", { url: `${origin}/bander/?scenario=compound` });
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (!(await evaluate<boolean>(`document.body.textContent.includes("If you say yes, Bander will check the latest information") && !document.body.textContent.includes("Draft not found")`))) throw new Error("The compound deep link did not initialize into a safe Card");
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

  await command("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await reload();
  await evaluate(`document.querySelector('[aria-label="Tap to ask — you drive everything here."]')?.click()`);
  if (!(await waitFor(`Boolean(document.querySelector(".suggested-message"))`))) throw new Error("The 375px Card journey did not reach the suggested parent message");
  await evaluate(`document.querySelector(".suggested-message")?.click()`);
  if (!(await waitFor(`Boolean(document.querySelector("[role=dialog]"))`))) throw new Error("The 375px Card journey did not open its dialog");
  const mobileCard = await evaluate<{ headingVisible: boolean; primaryLines: number; primaryHeight: number; primaryWidth: number; quietHeight: number; stacked: boolean }>(`(()=>{const heading=document.querySelector("[role=dialog] .deal-heading");const headingBox=heading?.getBoundingClientRect();const headingStyle=heading?getComputedStyle(heading):null;const primary=document.querySelector("[role=dialog] .primary");const quiet=document.querySelector("[role=dialog] .quiet");const range=document.createRange();if(primary)range.selectNodeContents(primary);const lineTops=new Set([...range.getClientRects()].map(rect=>Math.round(rect.top)));const primaryBox=primary?.getBoundingClientRect();const quietBox=quiet?.getBoundingClientRect();return{headingVisible:Boolean(heading?.textContent?.includes("Bander hasn’t done anything yet — please check:")&&headingBox&&headingBox.width>0&&headingBox.height>0&&headingStyle?.display!=="none"&&headingStyle?.visibility!=="hidden"),primaryLines:lineTops.size,primaryHeight:primaryBox?.height??0,primaryWidth:primaryBox?.width??0,quietHeight:quietBox?.height??0,stacked:Boolean(primaryBox&&quietBox&&quietBox.top>=primaryBox.bottom)}})()`);
  if (!mobileCard.headingVisible || mobileCard.primaryLines !== 1 || mobileCard.primaryHeight < 44 || mobileCard.primaryWidth < 250 || mobileCard.quietHeight < 44 || !mobileCard.stacked) throw new Error(`The 375px Card heading or action hierarchy is incomplete: ${JSON.stringify(mobileCard)}`);

  console.log("Pages browser QA verified: R1 idle/read/card/decline/approved states, visible Card heading, one-line stacked mobile approval actions, focus containment and restoration, reduced-motion semantics, page-wide scoped axe checks with zero violations, direct-route replay safety, zero external requests, and 1440×900 / 1280×720 / 500×900 / 375×812 layouts.");
} finally {
  socket.close();
}
