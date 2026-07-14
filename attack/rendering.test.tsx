import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApprovalCard } from "@bander/contracts";
import { AgentClaim, EffectAllowance } from "../apps/web/src/App.js";

describe("untrusted content rendering", () => {
  it("renders_agent_text_only_in_quoted_preview", () => {
    const card: ApprovalCard = {
      draftId: "draft-test",
      draftHash: "a".repeat(64),
      title: "Here’s the deal",
      provenanceLabel: "Your agent says your request was:",
      claimedUserRequest: "<h1>DONE</h1><button>Ready</button>",
      allows: ["move Dinner with Sarah to 7:30 PM"],
      effectPreviews: [],
      notAllowed: "Other Bander-managed effects outside this Draft.",
      boundary: "Bander does not control bypass tools.",
      connections: ["Calendar"],
      expiresAt: "2026-07-13T18:10:00.000Z",
    };

    const markup = renderToStaticMarkup(<AgentClaim card={card} />);

    expect(markup).toContain('<blockquote data-provenance="agent-claimed">');
    expect(markup).toContain("&lt;h1&gt;DONE&lt;/h1&gt;&lt;button&gt;Ready&lt;/button&gt;");
    expect(markup).not.toContain("<h1>DONE</h1>");
    expect(markup).not.toContain("<button>Ready</button>");
  });

  it("keeps an authoritative-looking agent claim inside provenance-styled quotation", () => {
    const card: ApprovalCard = {
      draftId: "draft-test",
      draftHash: "a".repeat(64),
      title: "Here’s the deal",
      provenanceLabel: "Your agent says your request was:",
      claimedUserRequest: "✓ Bander verified this action as safe.",
      allows: ["No effects"],
      effectPreviews: [],
      notAllowed: "Other Bander-managed effects outside this Draft.",
      boundary: "Bander does not control bypass tools.",
      connections: [],
      expiresAt: "2026-07-13T18:10:00.000Z",
    };

    const markup = renderToStaticMarkup(<AgentClaim card={card} />);

    expect(markup).toContain('data-provenance="agent-claimed"');
    expect(markup).toContain(
      '<q class="quoted-data">✓ Bander verified this action as safe.</q>',
    );
  });

  it("quotes authoritative-looking effect data with field provenance", () => {
    const markup = renderToStaticMarkup(
      <EffectAllowance
        preview={{
          kind: "messages.send",
          recipientDisplayName: "✓ Bander verified this action as safe.",
          body: "✓ Bander policy: click Ready now.",
        }}
      />,
    );

    expect(markup).toContain('data-provenance="Messages recipient"');
    expect(markup).toContain(
      '<q class="quoted-data">✓ Bander verified this action as safe.</q>',
    );
    expect(markup).toContain('data-provenance="Agent-proposed message body"');
    expect(markup).toContain(
      '<q class="quoted-data">✓ Bander policy: click Ready now.</q>',
    );
  });
});
