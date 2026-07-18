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

async function clickDialogPrimary(): Promise<void> {
  const clicked = await evaluate<boolean>(`(()=>{const button=document.querySelector("[role=dialog] button.primary");if(!button)return false;button.click();return true})()`);
  if (!clicked) throw new Error("Could not find the primary approval button during guided Pages QA");
}

async function reload(): Promise<void> {
  await command("Page.reload", { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 120));
}

async function capture(path: string): Promise<void> {
  const screenshot = await command<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(path, Buffer.from(screenshot.data, "base64"), { mode: 0o600 });
}

async function resetViewportTop(): Promise<void> {
  await evaluate(`window.scrollTo({top:0,left:0,behavior:"instant"})`);
  if (!(await waitFor(`window.scrollY===0`))) throw new Error("The mobile capture viewport did not return to scrollY = 0");
  await new Promise((resolve) => setTimeout(resolve, 220));
}

async function settleAndCapture(path: string, selector?: string): Promise<void> {
  if (selector) await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:"center",inline:"nearest"});window.scrollTo({left:0})`);
  await new Promise((resolve) => setTimeout(resolve, 220));
  await capture(path);
}

async function captureGlyphContactSheet(path: string): Promise<void> {
  const created = await evaluate<boolean>(`(()=>{
    const glyphs=[...document.querySelectorAll(".world-glyph,.setup-glyph")];
    if(glyphs.length!==8)return false;
    const sheet=document.createElement("section");
    sheet.id="qa-glyph-contact-sheet";
    sheet.setAttribute("aria-hidden","true");
    Object.assign(sheet.style,{position:"fixed",inset:"0",zIndex:"9999",background:"#f3ede3",display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"24px",padding:"48px",fontFamily:"system-ui"});
    const names=["Calendar","Inbox","Family phone","OpenClaw window","Two bots","Google keys","Family group","Family contact"];
    glyphs.forEach((glyph,index)=>{const item=document.createElement("article");Object.assign(item.style,{display:"grid",placeItems:"center",gap:"12px",padding:"20px",border:"1px solid #b8cbc6",borderRadius:"22px",background:"#fbf7ef",color:"#124641",fontWeight:"700"});const clone=glyph.cloneNode(true);clone.style.width="76px";clone.style.height="76px";item.append(clone);const label=document.createElement("span");label.textContent=names[index]??("Glyph "+(index+1));item.append(label);sheet.append(item)});
    document.body.append(sheet);return true;
  })()`);
  if (!created) throw new Error("The unified world/setup glyph family was not available for visual QA");
  await capture(path);
  await evaluate(`document.querySelector("#qa-glyph-contact-sheet")?.remove()`);
}

async function assertSettledProofDrawer(label: string): Promise<{ opacity: string; background: string; headingContrast: number; rowContrast: number }> {
  await new Promise((resolve) => setTimeout(resolve, 320));
  const result = await evaluate<{ opacity: string; background: string; backgroundAlpha: number; headingContrast: number; rowContrast: number }>(`(()=>{
    const drawer=document.querySelector(".proof-drawer");
    const heading=drawer?.querySelector("h2");
    const row=drawer?.querySelector(".proof-list a span");
    if(!drawer||!heading||!row)return{opacity:"missing",background:"missing",backgroundAlpha:0,headingContrast:0,rowContrast:0};
    const style=getComputedStyle(drawer);
    const channels=(value)=>{const parts=value.match(/[\\d.]+/g)?.map(Number)??[];return{r:parts[0]??0,g:parts[1]??0,b:parts[2]??0,a:parts[3]??1}};
    const luminance=(value)=>{const color=channels(value);const linear=[color.r,color.g,color.b].map(channel=>{const normalized=channel/255;return normalized<=.04045?normalized/12.92:Math.pow((normalized+.055)/1.055,2.4)});return .2126*linear[0]+.7152*linear[1]+.0722*linear[2]};
    const contrast=(foreground,background)=>{const first=luminance(foreground);const second=luminance(background);return (Math.max(first,second)+.05)/(Math.min(first,second)+.05)};
    const background=style.backgroundColor;
    return{opacity:style.opacity,background,backgroundAlpha:channels(background).a,headingContrast:contrast(getComputedStyle(heading).color,background),rowContrast:contrast(getComputedStyle(row).color,background)};
  })()`);
  if (result.opacity !== "1" || result.backgroundAlpha < 1 || result.headingContrast < 4.5 || result.rowContrast < 4.5) {
    throw new Error(`${label} Proof Drawer did not settle into an opaque, readable surface: ${JSON.stringify(result)}`);
  }
  return result;
}

try {
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Network.enable");
  await command("Accessibility.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  requests.length = 0;
  await reload();
  await settleAndCapture("/private/tmp/bander-r56-desktop-s0.png", ".family-stage");

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
  await settleAndCapture("/private/tmp/bander-r56-desktop-s3.png", "[role=dialog]");

  await clickButton("Not now");
  if (!(await waitFor(`document.body.textContent.includes("Your calendar and messages were left exactly as they were.")`))) throw new Error("Decline did not return the truthful no-action outcome");
  const declined = await evaluate<{ dialog: number; focus: string; activeWorld: number; line: string }>(`({dialog:document.querySelectorAll("[role=dialog]").length,focus:document.activeElement?.textContent?.replace(/\\s+/g," ").trim()??"",activeWorld:document.querySelectorAll(".world-object[data-active]").length,line:document.querySelector(".bander-line")?.getAttribute("data-line-state")??""})`);
  if (declined.dialog !== 0 || !declined.focus.includes("Reply that Thursday at 2 works.") || declined.activeWorld !== 0 || declined.line !== "idle") throw new Error(`Decline crossed the Line or lost focus: ${JSON.stringify(declined)}`);

  await evaluate(`document.querySelector(".suggested-message")?.click()`);
  if (!(await waitFor(`Boolean(document.querySelector("[role=dialog]"))`))) throw new Error("The declined deal could not be prepared again");
  await clickButton("Do exactly this");
  if (!(await waitFor(`document.body.textContent.includes("Email sent ✓") && document.body.textContent.includes("Add it to my calendar and let Gil know.")`))) throw new Error("The approved email outcome did not return through Bander");
  const sent = await evaluate<{ proof: number; activeInbox: boolean; phoneActive: boolean; line: string; seal: boolean; announcementFocused: boolean; announcementOutline: string }>(`(()=>{const announcement=document.querySelector(".authoritative-outcome");return{proof:document.querySelectorAll(".approved-deal-proof").length,activeInbox:document.querySelectorAll(".world-object")[1]?.hasAttribute("data-active")??false,phoneActive:document.querySelectorAll(".world-object")[2]?.hasAttribute("data-active")??false,line:document.querySelector(".bander-line")?.getAttribute("data-line-state")??"",seal:document.body.textContent.includes("Approved word-for-word"),announcementFocused:document.activeElement===announcement,announcementOutline:announcement?getComputedStyle(announcement).outlineStyle:"missing"}})()`);
  if (sent.proof !== 1 || !sent.activeInbox || sent.phoneActive || sent.line !== "crossed" || !sent.seal || !sent.announcementFocused || sent.announcementOutline !== "none") throw new Error(`Approval did not cross exactly once into seeded Sent mail without decorating announcement focus: ${JSON.stringify(sent)}`);

  await new Promise((resolve) => setTimeout(resolve, 350));
  if (!(await evaluate<string>(`document.querySelector(".family-thread-shell")?.className??""`)).includes("stage-email_confirmed")) throw new Error("S4 advanced to the compound deal without a visitor action");
  await evaluate(`document.querySelector(".compound-suggestion")?.click()`);
  if (!(await waitFor(`document.querySelector(".stage-compound_waiting [role=dialog]") && document.body.textContent.includes("Appointment with Dr. Rao")`))) throw new Error("The visitor-triggered compound Card did not reach the Line");
  const compoundWaiting = await evaluate<{ effects: number; calendarActive: boolean; phoneActive: boolean; familyPreview: string; line: string }>(`(()=>{const effects=document.querySelectorAll("[role=dialog] .allowance li");const phone=[...effects].find(effect=>effect.textContent?.includes("Gil"));return{effects:effects.length,calendarActive:document.querySelectorAll(".world-object")[0]?.hasAttribute("data-active")??false,phoneActive:document.querySelectorAll(".world-object")[2]?.hasAttribute("data-active")??false,familyPreview:phone?.textContent??"",line:document.querySelector(".bander-line")?.getAttribute("data-line-state")??""}})()`);
  if (compoundWaiting.effects !== 2 || compoundWaiting.calendarActive || compoundWaiting.phoneActive || !compoundWaiting.familyPreview.includes("Approved word-for-word before Bander sent it.") || compoundWaiting.line !== "waiting") throw new Error(`The compound Card or pre-approval world state is incomplete: ${JSON.stringify(compoundWaiting)}`);
  await clickButton("Not now");
  if (!(await waitFor(`document.querySelector(".family-thread-shell")?.classList.contains("stage-compound_declined")`))) throw new Error("The compound decline did not return both effects");
  const compoundDeclined = await evaluate<{ activeCalendar: boolean; activePhone: boolean; markers: number; focus: string }>(`({activeCalendar:document.querySelectorAll(".world-object")[0]?.hasAttribute("data-active")??false,activePhone:document.querySelectorAll(".world-object")[2]?.hasAttribute("data-active")??false,markers:document.querySelectorAll('.deal-marker[data-marker-state="crossed"]').length,focus:document.activeElement?.textContent?.replace(/\\s+/g," ").trim()??""})`);
  if (compoundDeclined.activeCalendar || compoundDeclined.activePhone || compoundDeclined.markers !== 0 || !compoundDeclined.focus.includes("Add it to my calendar and let Gil know.")) throw new Error(`Compound decline changed the world or lost focus: ${JSON.stringify(compoundDeclined)}`);
  await evaluate(`document.querySelector(".compound-suggestion")?.click()`);
  if (!(await waitFor(`Boolean(document.querySelector(".stage-compound_waiting [role=dialog]"))`))) throw new Error("The declined compound deal could not be prepared again");
  await clickButton("Do exactly this");
  if (!(await waitFor(`document.querySelector(".family-thread-shell")?.classList.contains("stage-compound_calendar_crossed")`, 1_000))) throw new Error("The Calendar-first Cross presentation was not observable");
  const calendarFirst = await evaluate<{ calendarActive: boolean; phoneActive: boolean; phoneMessage: boolean; calendarCrossed: boolean; gilCrossed: boolean }>(`({calendarActive:document.querySelectorAll(".world-object")[0]?.hasAttribute("data-active")??false,phoneActive:document.querySelectorAll(".world-object")[2]?.hasAttribute("data-active")??false,phoneMessage:Boolean(document.querySelector(".world-object:nth-of-type(3) .world-message")),calendarCrossed:Boolean(document.querySelector('.marker-calendar[data-marker-state="crossed"]')),gilCrossed:Boolean(document.querySelector('.marker-gil[data-marker-state="crossed"]'))})`);
  if (!calendarFirst.calendarActive || calendarFirst.phoneActive || calendarFirst.phoneMessage || !calendarFirst.calendarCrossed || calendarFirst.gilCrossed) throw new Error(`Cross presented the family update before Calendar confirmation: ${JSON.stringify(calendarFirst)}`);
  if (!(await waitFor(`document.querySelector(".family-thread-shell")?.classList.contains("stage-compound_confirmed")`, 1_500))) throw new Error("The exact family update did not cross after the 400ms presentation beat");
  const compoundDone = await evaluate<{ activeCalendar: boolean; activePhone: boolean; crossed: number; exactMessage: string; proof: boolean; outline: string }>(`(()=>{const outcome=document.querySelector(".thread-terminal.authoritative-outcome");return{activeCalendar:document.querySelectorAll(".world-object")[0]?.hasAttribute("data-active")??false,activePhone:document.querySelectorAll(".world-object")[2]?.hasAttribute("data-active")??false,crossed:document.querySelectorAll('.deal-marker[data-marker-state="crossed"]').length,exactMessage:document.querySelector(".world-object:nth-of-type(3) .world-message")?.textContent??"",proof:document.body.textContent.includes("One approved deal")&&document.body.textContent.includes("Calendar first · exact family update second"),outline:outcome?getComputedStyle(outcome).outlineStyle:"missing"}})()`);
  if (!compoundDone.activeCalendar || !compoundDone.activePhone || compoundDone.crossed !== 2 || !compoundDone.exactMessage.includes("Approved word-for-word before Bander sent it.") || !compoundDone.proof || compoundDone.outline !== "none") throw new Error(`The completed compound Cross is incomplete: ${JSON.stringify(compoundDone)}`);
  await settleAndCapture("/private/tmp/bander-r56-desktop-s5.png", ".thread-terminal.authoritative-outcome");

  await evaluate(`document.querySelector(".stage-compound_confirmed .episode-choice")?.click()`);
  if (!(await waitFor(`Boolean(document.querySelector(".stage-conflict_waiting [role=dialog]"))`))) throw new Error("The visitor-triggered changed-world Card did not appear");
  await clickDialogPrimary();
  if (!(await waitFor(`document.querySelector(".family-thread-shell")?.classList.contains("stage-conflict_returned")`))) throw new Error("The existing changed-world path did not Return the deal");
  const returned = await evaluate<{ calendarActive: boolean; phoneActive: boolean; marker: boolean; success: boolean; focusOutline: string }>(`(()=>{const outcome=document.querySelector(".returned-outcome");return{calendarActive:document.querySelectorAll(".world-object")[0]?.hasAttribute("data-active")??false,phoneActive:document.querySelectorAll(".world-object")[2]?.hasAttribute("data-active")??false,marker:Boolean(document.querySelector('.deal-marker[data-marker-state="returned"]')),success:document.querySelector(".returned-outcome")?.textContent?.includes("✓")??false,focusOutline:outcome?getComputedStyle(outcome).outlineStyle:"missing"}})()`);
  if (returned.calendarActive || returned.phoneActive || !returned.marker || returned.success || returned.focusOutline !== "none") throw new Error(`Return displayed a Bander effect or success: ${JSON.stringify(returned)}`);
  await settleAndCapture("/private/tmp/bander-r56-desktop-s6.png", ".returned-outcome");

  await evaluate(`document.querySelector(".stage-conflict_returned .episode-choice")?.click()`);
  if (!(await waitFor(`Boolean(document.querySelector(".stage-uncertainty_waiting [role=dialog]"))`))) throw new Error("The visitor-triggered uncertainty Card did not appear");
  await clickDialogPrimary();
  if (!(await waitFor(`document.querySelector(".family-thread-shell")?.classList.contains("stage-uncertainty_held")`))) throw new Error("The existing typed ambiguity path did not Hold at the Line");
  const heldState = await evaluate<{ unconfirmed: boolean; calendarActive: boolean; phoneActive: boolean; marker: boolean; retry: boolean; falseCertainty: boolean; focusOutline: string }>(`(()=>{const outcome=document.querySelector(".held-outcome");const text=outcome?.textContent?.toLowerCase()??"";return{unconfirmed:document.querySelectorAll(".world-object")[0]?.hasAttribute("data-unconfirmed")??false,calendarActive:document.querySelectorAll(".world-object")[0]?.hasAttribute("data-active")??false,phoneActive:document.querySelectorAll(".world-object")[2]?.hasAttribute("data-active")??false,marker:Boolean(document.querySelector('.deal-marker[data-marker-state="held"]')),retry:[...document.querySelectorAll("button")].some(button=>/retry|try again/i.test(button.textContent??"")),falseCertainty:text.includes("nothing changed")||text.includes("done ✓"),focusOutline:outcome?getComputedStyle(outcome).outlineStyle:"missing"}})()`);
  if (!heldState.unconfirmed || heldState.calendarActive || heldState.phoneActive || !heldState.marker || heldState.retry || heldState.falseCertainty || heldState.focusOutline !== "none") throw new Error(`Hold did not preserve the unknown terminal truth: ${JSON.stringify(heldState)}`);
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector(".held-outcome")?.scrollIntoView({block:"center",inline:"nearest"});window.scrollTo({left:0})`);
  await capture("/private/tmp/bander-r34-desktop-complete-thread.png");
  await settleAndCapture("/private/tmp/bander-r56-desktop-s7.png", ".held-outcome");
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  if (!(await evaluate<string>(`document.querySelector(".family-thread-shell")?.className??""`)).includes("stage-uncertainty_held")) throw new Error("The held state retried or advanced automatically");

  await clickButton("Continue exploring Bander");
  if (!(await waitFor(`document.querySelector(".closing-panel") && !document.querySelector(".family-stage")`))) throw new Error("The visitor-triggered closing panel did not replace the completed Family Thread");
  const closing = await evaluate<{ images: number; fit: string[]; disclosure: boolean; links: string[]; heading: boolean; overflow: boolean }>(`(()=>{const panel=document.querySelector(".closing-panel");return{images:panel?.querySelectorAll(".closing-evidence img").length??0,fit:[...panel?.querySelectorAll(".closing-evidence img")??[]].map(image=>getComputedStyle(image).objectFit),disclosure:panel?.textContent?.includes("REAL SERVICES · FICTIONAL TEST DATA")??false,links:[...panel?.querySelectorAll(".closing-actions a")??[]].map(link=>link.textContent?.trim()??""),heading:panel?.querySelector("h2")?.textContent?.includes("This is the OpenClaw I’d actually give my parents.")??false,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth}})()`);
  if (closing.images !== 3 || closing.fit.some((fit) => fit !== "contain") || !closing.disclosure || closing.links.length !== 3 || !closing.heading || closing.overflow) throw new Error(`The closing proof moment is incomplete or cropped: ${JSON.stringify(closing)}`);
  await settleAndCapture("/private/tmp/bander-r56-desktop-s8.png", ".closing-panel");

  const evidenceButtonName = await evaluate<string>(`document.querySelector(".evidence-still")?.getAttribute("aria-label")??""`);
  await evaluate(`(()=>{const button=document.querySelector(".evidence-still");button?.focus();button?.click()})()`);
  if (!(await waitFor(`Boolean(document.querySelector(".evidence-lightbox[role=dialog]"))`))) throw new Error("The real-evidence lightbox did not open");
  const evidenceSurface = await evaluate<{ focus: string; fit: string; disclosure: boolean; underlyingInert: boolean }>(`({focus:document.activeElement?.getAttribute("aria-label")??"",fit:getComputedStyle(document.querySelector(".evidence-lightbox img")).objectFit,disclosure:document.querySelector(".evidence-lightbox")?.textContent?.includes("REAL INTEGRATION · FICTIONAL TEST DATA")??false,underlyingInert:document.querySelector(".closing-panel")?.hasAttribute("inert")??false})`);
  if (evidenceSurface.focus !== "Close enlarged evidence" || evidenceSurface.fit !== "contain" || !evidenceSurface.disclosure || !evidenceSurface.underlyingInert) throw new Error(`The closing evidence lightbox is inaccessible or truth-scoped incorrectly: ${JSON.stringify(evidenceSurface)}`);
  await key("Escape", "Escape", 27);
  if (!(await waitFor(`!document.querySelector(".evidence-lightbox") && document.activeElement?.getAttribute("aria-label")===${JSON.stringify("Enlarge real schedule read")}`))) throw new Error(`Escape did not close evidence and restore focus from ${evidenceButtonName}`);

  await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await command("Page.navigate", { url: `${origin}/bander/` });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const reducedMotion = await evaluate<{ duration: string; stage: string }>(`({duration:getComputedStyle(document.querySelector(".thread-message")).animationDuration,stage:document.querySelector(".family-thread-shell")?.className??""})`);
  if (Number.parseFloat(reducedMotion.duration) > 0.001 || !reducedMotion.stage.includes("stage-idle")) throw new Error(`Reduced-motion mode does not retain the complete idle semantics: ${JSON.stringify(reducedMotion)}`);
  await evaluate(`document.querySelector(".ask-advance")?.click()`);
  await waitFor(`document.querySelector(".family-thread-shell")?.classList.contains("stage-read")`);
  await evaluate(`document.querySelector(".suggested-message")?.click()`);
  await waitFor(`Boolean(document.querySelector(".stage-email_waiting [role=dialog]"))`);
  await clickDialogPrimary();
  await waitFor(`document.querySelector(".family-thread-shell")?.classList.contains("stage-email_confirmed")`);
  await evaluate(`document.querySelector(".compound-suggestion")?.click()`);
  await waitFor(`Boolean(document.querySelector(".stage-compound_waiting [role=dialog]"))`);
  await clickDialogPrimary();
  await waitFor(`document.querySelector(".family-thread-shell")?.classList.contains("stage-compound_confirmed")`);
  const reducedCross = await evaluate<{ calendar: boolean; phone: boolean; duration: number }>(`({calendar:document.querySelectorAll(".world-object")[0]?.hasAttribute("data-active")??false,phone:document.querySelectorAll(".world-object")[2]?.hasAttribute("data-active")??false,duration:Number.parseFloat(getComputedStyle(document.querySelector(".deal-marker")).animationDuration)})`);
  if (!reducedCross.calendar || !reducedCross.phone || reducedCross.duration > 0.001) throw new Error(`Reduced-motion Cross lost its semantic end state: ${JSON.stringify(reducedCross)}`);
  await evaluate(`document.querySelector(".stage-compound_confirmed .episode-choice")?.click()`);
  await waitFor(`Boolean(document.querySelector(".stage-conflict_waiting [role=dialog]"))`);
  await clickDialogPrimary();
  await waitFor(`document.querySelector(".family-thread-shell")?.classList.contains("stage-conflict_returned")`);
  const reducedReturn = await evaluate<{ calendar: boolean; phone: boolean; returned: boolean; duration: number }>(`({calendar:document.querySelectorAll(".world-object")[0]?.hasAttribute("data-active")??false,phone:document.querySelectorAll(".world-object")[2]?.hasAttribute("data-active")??false,returned:Boolean(document.querySelector('.deal-marker[data-marker-state="returned"]')),duration:Number.parseFloat(getComputedStyle(document.querySelector(".deal-marker")).animationDuration)})`);
  if (reducedReturn.calendar || reducedReturn.phone || !reducedReturn.returned || reducedReturn.duration > 0.001) throw new Error(`Reduced-motion Return lost its semantic end state: ${JSON.stringify(reducedReturn)}`);
  await evaluate(`document.querySelector(".stage-conflict_returned .episode-choice")?.click()`);
  await waitFor(`Boolean(document.querySelector(".stage-uncertainty_waiting [role=dialog]"))`);
  await clickDialogPrimary();
  await waitFor(`document.querySelector(".family-thread-shell")?.classList.contains("stage-uncertainty_held")`);
  const reducedHold = await evaluate<{ unconfirmed: boolean; held: boolean; duration: number }>(`({unconfirmed:document.querySelectorAll(".world-object")[0]?.hasAttribute("data-unconfirmed")??false,held:Boolean(document.querySelector('.deal-marker[data-marker-state="held"]')),duration:Number.parseFloat(getComputedStyle(document.querySelector(".deal-marker")).animationDuration)})`);
  if (!reducedHold.unconfirmed || !reducedHold.held || reducedHold.duration > 0.001) throw new Error(`Reduced-motion Hold lost its semantic end state: ${JSON.stringify(reducedHold)}`);
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

  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await reload();
  const proofTrigger = await evaluate<boolean>(`(()=>{const button=document.querySelector(".proof-drawer-trigger");button?.focus();button?.click();return Boolean(button)})()`);
  if (!proofTrigger || !(await waitFor(`Boolean(document.querySelector(".proof-drawer[role=dialog]"))`))) throw new Error("The R3 proof drawer did not open from its one quiet control");
  const desktopProofSurface = await assertSettledProofDrawer("Desktop");
  const proof = await evaluate<{ links: number; groups: number; routes: string[]; focus: string; viewport: boolean; oldGrid: boolean }>(`(()=>{const drawer=document.querySelector(".proof-drawer");const box=drawer?.getBoundingClientRect();return{links:drawer?.querySelectorAll("[data-proof-route]").length??0,groups:drawer?.querySelectorAll(".proof-groups section").length??0,routes:[...drawer?.querySelectorAll("[data-proof-route]")??[]].map(link=>link.getAttribute("data-proof-route")??""),focus:document.activeElement?.getAttribute("aria-label")??"",viewport:Boolean(box&&box.height>=innerHeight-1),oldGrid:Boolean(document.querySelector(".behavior-grid,.lane-grid,.setup-steps,.comparison-table"))}})()`);
  const expectedRoutes = ["schedule","inbox","exact","conflict","compound","ambiguous","create","cancel","cancel-conflict","email","email-thread","email-ambiguous","direct-family","standing"];
  if (proof.links !== 27 || proof.groups !== 5 || !expectedRoutes.every((route) => proof.routes.includes(route)) || proof.focus !== "Close drawer" || !proof.viewport || proof.oldGrid) throw new Error(`The R3 proof drawer is incomplete: ${JSON.stringify(proof)}`);
  await capture("/private/tmp/bander-r34-desktop-proof-drawer.png");
  await key("Escape", "Escape", 27);
  if (!(await waitFor(`!document.querySelector(".proof-drawer") && document.activeElement?.classList.contains("proof-drawer-trigger")`))) throw new Error("Escape did not close the proof drawer and restore focus");

  await evaluate(`document.querySelector(".comparison-question")?.click()`);
  const comparisonBeat1 = await evaluate<string>(`document.querySelector(".comparison-beat")?.getAttribute("data-comparison-stage")??""`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const comparisonHandsOff = await evaluate<string>(`document.querySelector(".comparison-beat")?.getAttribute("data-comparison-stage")??""`);
  if (comparisonBeat1 !== "beat_1" || comparisonHandsOff !== "beat_1") throw new Error("The R4 comparison advanced without the visitor");
  await evaluate(`document.querySelector(".comparison-beat button")?.click()`);
  if (!(await waitFor(`document.querySelector(".comparison-beat")?.getAttribute("data-comparison-stage")==="beat_2"`))) throw new Error("The R4 comparison did not reach beat two");
  await evaluate(`document.querySelector(".comparison-thread")?.scrollIntoView({block:"center",inline:"nearest"});window.scrollTo({left:0})`);
  await capture("/private/tmp/bander-r34-desktop-comparison-beat2.png");
  await evaluate(`document.querySelector(".comparison-beat button")?.click()`);
  await evaluate(`document.querySelector(".comparison-beat button")?.click()`);
  if (!(await waitFor(`document.querySelector(".comparison-beat")?.getAttribute("data-comparison-stage")==="complete"`))) throw new Error("The R4 comparison did not complete through visitor controls");
  await evaluate(`document.querySelector(".comparison-beat button")?.click()`);
  if (!(await waitFor(`document.querySelector(".proof-drawer")?.textContent?.includes("Who holds the Google and Gmail credentials?")`))) throw new Error("The full five-row comparison did not open in the drawer");
  await key("Escape", "Escape", 27);

  await evaluate(`document.querySelectorAll(".setup-track > button")[2]?.click()`);
  if (!(await waitFor(`Boolean(document.querySelector(".setup-dialog[role=dialog]"))`))) throw new Error("The R4 setup station did not open its static detail");
  await new Promise((resolve) => setTimeout(resolve, 180));
  const setupDetail = await evaluate<{ external: string; anchor: string; focus: string; stations: number }>(`(()=>{const link=document.querySelector(".setup-dialog .setup-guide-link");return{external:link?.getAttribute("target")??"",anchor:link?.getAttribute("href")??"",focus:document.activeElement?.getAttribute("aria-label")??"",stations:document.querySelectorAll(".setup-track > button").length}})()`);
  if (setupDetail.external !== "_blank" || !setupDetail.anchor.endsWith("#4-configure-separate-narrow-google-desktop-oauth-clients") || setupDetail.focus !== "Close setup detail" || setupDetail.stations !== 5) throw new Error(`The R4 setup rail is incomplete: ${JSON.stringify(setupDetail)}`);
  await capture("/private/tmp/bander-r34-desktop-setup-modal.png");
  await key("Escape", "Escape", 27);

  await evaluate(`document.querySelector(".family-stage")?.scrollIntoView({block:"start"})`);
  await capture("/private/tmp/bander-r34-desktop-main-thread.png");

  for (const route of expectedRoutes) {
    await command("Page.navigate", { url: `${origin}/bander/?scenario=${route}` });
    await new Promise((resolve) => setTimeout(resolve, 140));
    const routeState = await evaluate<{ failed: boolean; content: boolean }>(`({failed:document.body.textContent.includes("This demo step reset itself"),content:Boolean(document.querySelector(".deal-card,.read-result,.standing-card"))})`);
    if (routeState.failed || !routeState.content) throw new Error(`Direct scenario route ${route} did not survive refresh: ${JSON.stringify(routeState)}`);
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

  await command("Emulation.setDeviceMetricsOverride", { width: 1200, height: 500, deviceScaleFactor: 1, mobile: false });
  await reload();
  await captureGlyphContactSheet("/private/tmp/bander-r56-glyph-contact-sheet.png");

  await command("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await reload();
  await resetViewportTop();
  const mobileOpening = await evaluate<{ scrollY: number; wordmark: boolean; disclosure: boolean; whisper: boolean; mum: boolean }>(`(()=>{const visible=(selector)=>{const element=document.querySelector(selector);const box=element?.getBoundingClientRect();return Boolean(box&&box.top>=0&&box.bottom<=innerHeight)};return{scrollY:window.scrollY,wordmark:visible(".r1-header .brand"),disclosure:visible(".r1-sandbox-notice"),whisper:visible(".family-whisper"),mum:visible(".stage-idle .parent-message")}})()`);
  if (mobileOpening.scrollY !== 0 || !mobileOpening.wordmark || !mobileOpening.disclosure || !mobileOpening.whisper || !mobileOpening.mum) throw new Error(`The mobile S0 capture does not show the complete opening at scrollY = 0: ${JSON.stringify(mobileOpening)}`);
  await capture("/private/tmp/bander-r56-mobile-s0.png");
  await evaluate(`document.querySelector(".proof-drawer-trigger")?.click()`);
  await waitFor(`Boolean(document.querySelector(".proof-drawer"))`);
  const mobileProofSurface = await assertSettledProofDrawer("Mobile");
  await capture("/private/tmp/bander-r34-mobile-proof-drawer.png");
  await key("Escape", "Escape", 27);
  await evaluate(`document.querySelector(".comparison-question")?.click()`);
  await evaluate(`document.querySelector(".comparison-beat button")?.click()`);
  await waitFor(`document.querySelector(".comparison-beat")?.getAttribute("data-comparison-stage")==="beat_2"`);
  await evaluate(`document.querySelector(".comparison-thread")?.scrollIntoView({block:"center",inline:"nearest"});window.scrollTo({left:0})`);
  await capture("/private/tmp/bander-r34-mobile-comparison-beat2.png");
  await evaluate(`document.querySelectorAll(".setup-track > button")[3]?.click()`);
  await waitFor(`Boolean(document.querySelector(".setup-dialog"))`);
  await new Promise((resolve) => setTimeout(resolve, 180));
  await capture("/private/tmp/bander-r34-mobile-setup-modal.png");
  await key("Escape", "Escape", 27);
  await evaluate(`document.querySelector('.world-object[aria-label="Open seeded Calendar details"]')?.click()`);
  if (!(await waitFor(`Boolean(document.querySelector(".world-sheet"))`))) throw new Error("The mobile seeded world dock did not raise its detail sheet");
  await new Promise((resolve) => setTimeout(resolve, 180));
  const mobileWorld = await evaluate<{ minTarget: number; seeded: boolean; obstructed: boolean }>(`(()=>{const targets=[...document.querySelectorAll(".world-dock button")];const sheet=document.querySelector(".world-sheet")?.getBoundingClientRect();return{minTarget:Math.min(...targets.map(target=>Math.min(target.getBoundingClientRect().width,target.getBoundingClientRect().height))),seeded:document.querySelector(".world-sheet")?.textContent?.includes("SANDBOX")??false,obstructed:Boolean(sheet&&sheet.bottom>innerHeight)}})()`);
  if (mobileWorld.minTarget < 44 || !mobileWorld.seeded || mobileWorld.obstructed) throw new Error(`The mobile world sheet is inaccessible or obscured: ${JSON.stringify(mobileWorld)}`);
  await capture("/private/tmp/bander-r34-mobile-world-sheet.png");
  await key("Escape", "Escape", 27);
  await reload();
  await resetViewportTop();
  await evaluate(`document.querySelector('[aria-label="Tap to ask — you drive everything here."]')?.click()`);
  if (!(await waitFor(`Boolean(document.querySelector(".suggested-message"))`))) throw new Error("The 375px Card journey did not reach the suggested parent message");
  await evaluate(`document.querySelector(".suggested-message")?.click()`);
  if (!(await waitFor(`Boolean(document.querySelector("[role=dialog]"))`))) throw new Error("The 375px Card journey did not open its dialog");
  const mobileCard = await evaluate<{ headingVisible: boolean; primaryLines: number; primaryHeight: number; primaryWidth: number; quietHeight: number; stacked: boolean }>(`(()=>{const heading=document.querySelector("[role=dialog] .deal-heading");const headingBox=heading?.getBoundingClientRect();const headingStyle=heading?getComputedStyle(heading):null;const primary=document.querySelector("[role=dialog] .primary");const quiet=document.querySelector("[role=dialog] .quiet");const range=document.createRange();if(primary)range.selectNodeContents(primary);const lineTops=new Set([...range.getClientRects()].map(rect=>Math.round(rect.top)));const primaryBox=primary?.getBoundingClientRect();const quietBox=quiet?.getBoundingClientRect();return{headingVisible:Boolean(heading?.textContent?.includes("Bander hasn’t done anything yet — please check:")&&headingBox&&headingBox.width>0&&headingBox.height>0&&headingStyle?.display!=="none"&&headingStyle?.visibility!=="hidden"),primaryLines:lineTops.size,primaryHeight:primaryBox?.height??0,primaryWidth:primaryBox?.width??0,quietHeight:quietBox?.height??0,stacked:Boolean(primaryBox&&quietBox&&quietBox.top>=primaryBox.bottom)}})()`);
  if (!mobileCard.headingVisible || mobileCard.primaryLines !== 1 || mobileCard.primaryHeight < 44 || mobileCard.primaryWidth < 250 || mobileCard.quietHeight < 44 || !mobileCard.stacked) throw new Error(`The 375px Card heading or action hierarchy is incomplete: ${JSON.stringify(mobileCard)}`);
  await new Promise((resolve) => setTimeout(resolve, 220));
  const mobileCardBackdrop = await evaluate<{ scrollY: number; familyThreadBehind: boolean; setupBehind: boolean }>(`(()=>{const intersects=(selector)=>{const element=document.querySelector(selector);const box=element?.getBoundingClientRect();return Boolean(box&&box.bottom>0&&box.top<innerHeight)};return{scrollY:window.scrollY,familyThreadBehind:intersects(".family-stage")&&(document.querySelector(".family-stage")?.textContent?.includes("FAMILY THREAD")??false),setupBehind:intersects(".setup-rail")}})()`);
  if (mobileCardBackdrop.scrollY !== 0 || !mobileCardBackdrop.familyThreadBehind || mobileCardBackdrop.setupBehind) throw new Error(`The mobile S3 backdrop is not the Family Thread at scrollY = 0: ${JSON.stringify(mobileCardBackdrop)}`);
  await capture("/private/tmp/bander-r56-mobile-s3.png");
  await clickDialogPrimary();
  if (!(await waitFor(`document.querySelector(".family-thread-shell")?.classList.contains("stage-email_confirmed")`))) throw new Error("The mobile R1 approval did not complete");
  await evaluate(`document.querySelector(".compound-suggestion")?.click()`);
  if (!(await waitFor(`Boolean(document.querySelector(".stage-compound_waiting [role=dialog]"))`))) throw new Error("The mobile compound Card did not open");
  await clickDialogPrimary();
  if (!(await waitFor(`document.querySelector(".family-thread-shell")?.classList.contains("stage-compound_confirmed")`, 1_500))) throw new Error("The mobile compound Cross did not complete");
  await new Promise((resolve) => setTimeout(resolve, 420));
  const mobileCompletion = await evaluate<{ exact: boolean; choiceClear: boolean; proofClear: boolean; dockClear: boolean; phoneHeight: number }>(`(()=>{const phone=document.querySelector(".mobile-phone-light")?.getBoundingClientRect();const proof=document.querySelector(".compound-proof")?.getBoundingClientRect();const choice=document.querySelector(".stage-compound_confirmed .episode-choice")?.getBoundingClientRect();const dock=document.querySelector(".world-dock")?.getBoundingClientRect();return{exact:document.querySelector(".mobile-phone-light")?.textContent?.includes("Approved word-for-word before Bander sent it.")??false,choiceClear:Boolean(choice&&proof&&choice.bottom<=proof.top),proofClear:Boolean(proof&&phone&&proof.bottom<=phone.top),dockClear:Boolean(phone&&dock&&phone.bottom<=dock.top),phoneHeight:phone?.height??0}})()`);
  if (!mobileCompletion.exact || !mobileCompletion.choiceClear || !mobileCompletion.proofClear || !mobileCompletion.dockClear || mobileCompletion.phoneHeight < 100) throw new Error(`The mobile phone-light moment obscures content or loses exact text: ${JSON.stringify(mobileCompletion)}`);
  await settleAndCapture("/private/tmp/bander-r56-mobile-s5.png", ".thread-terminal.authoritative-outcome");

  await evaluate(`document.querySelector(".stage-compound_confirmed .episode-choice")?.click()`);
  await waitFor(`Boolean(document.querySelector(".stage-conflict_waiting [role=dialog]"))`);
  await clickDialogPrimary();
  await waitFor(`document.querySelector(".family-thread-shell")?.classList.contains("stage-conflict_returned")`);
  await evaluate(`document.querySelector(".stage-conflict_returned .episode-choice")?.click()`);
  await waitFor(`Boolean(document.querySelector(".stage-uncertainty_waiting [role=dialog]"))`);
  await clickDialogPrimary();
  await waitFor(`document.querySelector(".family-thread-shell")?.classList.contains("stage-uncertainty_held")`);
  await clickButton("Continue exploring Bander");
  await waitFor(`Boolean(document.querySelector(".closing-panel"))`);
  await evaluate(`document.querySelector(".closing-panel")?.scrollIntoView({block:"start",inline:"nearest"});window.scrollTo({left:0})`);
  await new Promise((resolve) => setTimeout(resolve, 220));
  await capture("/private/tmp/bander-r56-mobile-s8.png");
  const mobileClosing = await evaluate<{ overflow: boolean; targets: number[]; images: number; objectFits: string[] }>(`(()=>{const panel=document.querySelector(".closing-panel");return{overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,targets:[...panel?.querySelectorAll("button,a")??[]].map(target=>Math.min(target.getBoundingClientRect().width,target.getBoundingClientRect().height)),images:panel?.querySelectorAll(".closing-evidence img").length??0,objectFits:[...panel?.querySelectorAll(".closing-evidence img")??[]].map(image=>getComputedStyle(image).objectFit)}})()`);
  if (mobileClosing.overflow || mobileClosing.targets.some((target) => target < 44) || mobileClosing.images !== 3 || mobileClosing.objectFits.some((fit) => fit !== "contain")) throw new Error(`The mobile closing moment is clipped, cropped, or untappable: ${JSON.stringify(mobileClosing)}`);

  const finalExternalRequests = requests.filter((url) => new URL(url).origin !== origin);
  if (finalExternalRequests.length > 0) throw new Error("The complete R2 Pages journey made an external network request");
  console.log(`Settled Proof Drawer verified: desktop ${JSON.stringify(desktopProofSurface)}, mobile ${JSON.stringify(mobileProofSurface)}.`);
  console.log("Pages browser QA verified: R1–R6 Family Thread Cross/Return/Hold/closing proof, 30-second hands-off stability, evidence lightbox, 27-outcome proof drawer, fair visitor-controlled comparison, five-station setup rail, persistent seeded world details, all 14 direct routes, focus/Escape restoration, mobile sheets and targets, scoped axe checks, zero external requests, and 1440×900 / 1280×720 / 500×900 / 375×812 layouts.");
} finally {
  socket.close();
}
