const PALETTE = [
  "bg-sky-100 text-sky-900",
  "bg-amber-100 text-amber-900",
  "bg-emerald-100 text-emerald-900",
  "bg-rose-100 text-rose-900",
  "bg-violet-100 text-violet-900",
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

function paletteFor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length] ?? "bg-slate-100 text-slate-900";
}

const SIZES = {
  sm: "h-10 w-10 text-sm",
  md: "h-14 w-14 text-lg",
  lg: "h-24 w-24 text-3xl",
} as const;

/** Persona avatar: initials on a color picked from the name. No photos. */
export function InitialsAvatar({
  name,
  size = "md",
  speaking = false,
}: {
  name: string;
  size?: keyof typeof SIZES;
  speaking?: boolean;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      {speaking ? (
        <span
          aria-hidden
          className="absolute inset-0 animate-ping rounded-full bg-cyan/40 motion-reduce:animate-none"
        />
      ) : null}
      <span
        aria-hidden
        className={`relative inline-flex items-center justify-center rounded-full font-semibold ring-2 transition ${SIZES[size]} ${paletteFor(name)} ${speaking ? "ring-cyan" : "ring-white"}`}
      >
        {initials(name)}
      </span>
    </span>
  );
}
