export type Source = {
  id: string;
  title?: string;
  url: string;
  snippet?: string;
  provider: "grok" | "tavily" | "firecrawl";
  retrieved_at: string;
};

export function normalizeHttpUrl(input: string) {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are supported.");
  url.hash = "";
  return url.toString();
}

export function cleanUrlCandidate(input: string) {
  let value = input.trim();
  for (const marker of ["**[[", "[[", "**", "<", "\"", "'"]) {
    const index = value.indexOf(marker);
    if (index > 0) value = value.slice(0, index);
  }
  return value.replace(/[)\]\}>,.;:*]+$/g, "");
}

export function sourcesFromText(text: string, provider: Source["provider"], limit: number, retrievedAt: () => string): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  const markdownLink = /\[[^\]]+\]\((https?:\/\/[^)\s<>"']+)\)/g;
  const bareUrl = /https?:\/\/[^\s)\]\}>"']+/g;
  for (const pattern of [markdownLink, bareUrl]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) && out.length < limit) {
      const rawUrl = cleanUrlCandidate(match[1] || match[0]);
      try {
        const url = normalizeHttpUrl(rawUrl);
        if (seen.has(url)) continue;
        seen.add(url);
        out.push({ id: crypto.randomUUID(), url, provider, retrieved_at: retrievedAt() });
      } catch {}
    }
  }
  return out;
}
