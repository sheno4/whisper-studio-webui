const URL_MATCHER =
  /(?:(?:https?:\/\/)|(?:www\.)|(?:x\.com\/)|(?:twitter\.com\/)|(?:youtu\.be\/)|(?:youtube\.com\/)|(?:b23\.tv\/)|(?:bilibili\.com\/)|(?:v\.douyin\.com\/)|(?:douyin\.com\/)|(?:tiktok\.com\/))[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/giu;

const MARKDOWN_LINK_MATCHER = /\[[^\]\r\n]*\]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/giu;
const TRAILING_PUNCTUATION = /[)\],.;!?'"`，。！；：、）》】）]+$/u;
const MARKDOWN_ESCAPE = /\\([\\`*_[\]{}()#+\-.!])/gu;

const dedupePreserveOrder = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
};

const cleanMatchedLink = (value: string): string => {
  return value.trim().replace(MARKDOWN_ESCAPE, '$1').replace(TRAILING_PUNCTUATION, '');
};

const extractMarkdownLinkTargets = (value: string): { links: string[]; remainingText: string } => {
  const links: string[] = [];
  const remainingText = value.replace(MARKDOWN_LINK_MATCHER, (_match, target: string) => {
    links.push(cleanMatchedLink(target));
    return ' ';
  });

  return { links, remainingText };
};

const normalizeDouyinUrl = (parsed: URL): string | undefined => {
  if (!isDouyinLink(parsed.toString())) {
    return undefined;
  }

  const modalId = parsed.searchParams.get('modal_id')?.trim();
  if (modalId && /^\d{8,}$/.test(modalId)) {
    return `https://www.douyin.com/video/${modalId}`;
  }

  const itemId = parsed.searchParams.get('item_id')?.trim();
  if (itemId && /^\d{8,}$/.test(itemId)) {
    return `https://www.douyin.com/video/${itemId}`;
  }

  return undefined;
};

export const isDouyinLink = (input: string): boolean => {
  try {
    const hostname = new URL(input).hostname.toLowerCase();
    return hostname === 'douyin.com' || hostname.endsWith('.douyin.com') || hostname.endsWith('.iesdouyin.com');
  } catch {
    return false;
  }
};

export const normalizeLinkCandidate = (value: string): string | undefined => {
  const trimmed = cleanMatchedLink(value);
  if (!trimmed) {
    return undefined;
  }

  if (/^BV[A-Za-z0-9]{10}$/.test(trimmed)) {
    return `https://www.bilibili.com/video/${trimmed}/`;
  }

  const hasProtocol = /^https?:\/\//i.test(trimmed);
  const candidate = hasProtocol ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    // URL accepts any single word (including Chinese prose) as a hostname.
    // Only infer HTTPS for a domain/IP, rather than turning share text into tasks.
    if (!hasProtocol && (
      parsed.username || parsed.password ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i.test(parsed.hostname)
    )) {
      return undefined;
    }

    const normalizedDouyinUrl = normalizeDouyinUrl(parsed);
    if (normalizedDouyinUrl) {
      return normalizedDouyinUrl;
    }

    return parsed.toString();
  } catch {
    return undefined;
  }
};

export const extractLinksFromText = (value: string): string[] => {
  const { links: markdownLinks, remainingText } = extractMarkdownLinkTargets(value);
  const scanText = remainingText.replace(MARKDOWN_ESCAPE, '$1');
  const rawMatches = [
    ...markdownLinks,
    ...Array.from(scanText.matchAll(URL_MATCHER), (match) => cleanMatchedLink(match[0]))
  ];

  const candidates = rawMatches.length > 0 ? rawMatches : scanText.split(/\s+/);

  return dedupePreserveOrder(
    candidates
      .map((item) => normalizeLinkCandidate(item))
      .filter((item): item is string => Boolean(item))
  );
};

export const extractLinksFromInputs = (values: string[]): string[] => {
  return dedupePreserveOrder(values.flatMap((value) => extractLinksFromText(value)));
};
