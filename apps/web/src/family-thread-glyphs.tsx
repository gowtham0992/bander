export type WorldGlyphKind = "calendar" | "inbox" | "phone";
export type SetupGlyphKind = "window" | "bots" | "key" | "group" | "family";

export function WorldGlyph({ kind }: { kind: WorldGlyphKind }) {
  if (kind === "calendar") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path className="glyph-paper" d="M9 13.5h30v26H9z" />
        <path className="glyph-wash" d="M9 13.5h30v8H9z" />
        <path d="M9 21.5h30M16 9.5v8M32 9.5v8" />
        <path className="glyph-red" d="M16 27h8v8h-8z" />
        <path className="glyph-quiet" d="M28 28.5h6M28 33h4" />
        <path className="glyph-stitch" d="M12.5 17.5h3M33 17.5h2.5" />
      </svg>
    );
  }
  if (kind === "inbox") {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path className="glyph-paper" d="M7.5 13.5h33v24h-33z" />
        <path className="glyph-wash" d="m8.5 15 15.5 13L39.5 15" />
        <path d="m8.5 36 10.5-9M39.5 36 29 27" />
        <path className="glyph-red" d="M31 29h9v8h-9z" />
        <path className="glyph-quiet" d="m33 33 2 2 4-5" />
        <path className="glyph-stitch" d="M12 17.5h4" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <rect className="glyph-paper" x="13" y="5.5" width="22" height="37" rx="6" />
      <path className="glyph-wash" d="M17 12h14v19H17z" />
      <path d="M20.5 9h7M21.5 37.5h5" />
      <path className="glyph-red" d="M27 17h9v9h-9z" />
      <path className="glyph-quiet" d="m29 21.5 2 2 4-5" />
      <path className="glyph-stitch" d="M19 15h5" />
    </svg>
  );
}

export function SetupGlyph({ kind }: { kind: SetupGlyphKind }) {
  return (
    <span className={`setup-glyph setup-${kind}`} aria-hidden="true">
      <svg viewBox="0 0 48 48">
        <rect className="setup-frame" x="4.5" y="4.5" width="39" height="39" rx="12" />
        {kind === "window" && <><rect x="12" y="13" width="24" height="19" rx="3" /><path d="M12 18h24M16 15.5h1M20 15.5h1" /><path className="setup-red" d="M27 28h7" /></>}
        {kind === "bots" && <><path d="M11 17h19v13H17l-5 4v-4h-1z" /><path d="M20 22h17v12H25l-4 3v-3" /><path className="setup-red" d="M16 23h8" /></>}
        {kind === "key" && <><circle cx="18" cy="24" r="7" /><path d="M25 24h13M33 24v5M37 24v3" /><circle className="setup-red" cx="18" cy="24" r="2" /></>}
        {kind === "group" && <><circle cx="19" cy="18" r="5" /><circle cx="31" cy="20" r="4" /><path d="M9 35c1-7 5-10 10-10s9 3 10 10M27 27c6 0 9 3 10 8" /><path className="setup-red" d="M12 35h14" /></>}
        {kind === "family" && <><circle cx="24" cy="17" r="6" /><path d="M12 36c1-8 5-12 12-12s11 4 12 12" /><path className="setup-red" d="m31 12 3 3 5-6" /></>}
      </svg>
    </span>
  );
}
