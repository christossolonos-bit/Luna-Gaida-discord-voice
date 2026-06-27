export interface RssItem {
  title: string;
  link: string;
  published?: string;
  summary?: string;
}

const USER_AGENT = 'giada-assistant/0.1 (Luna RSS)';

export async function fetchRssItems(feedUrl: string, limit = 8): Promise<RssItem[]> {
  const response = await fetch(feedUrl, {
    headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000)
  }).catch(() => null);

  if (!response?.ok) {
    return [];
  }

  const xml = await response.text();
  return parseFeedXml(xml, limit);
}

export async function fetchRssHeadlines(feedUrls: string[], limitPerFeed = 5, maxTotal = 12): Promise<RssItem[]> {
  const items: RssItem[] = [];
  for (const feedUrl of feedUrls) {
    const batch = await fetchRssItems(feedUrl, limitPerFeed);
    items.push(...batch);
    if (items.length >= maxTotal) break;
  }
  return items.slice(0, maxTotal);
}

export function parseFeedXml(xml: string, limit: number): RssItem[] {
  const isAtom = /<feed[\s>]/i.test(xml);
  return isAtom ? parseAtom(xml, limit) : parseRss(xml, limit);
}

function parseRss(xml: string, limit: number): RssItem[] {
  const items: RssItem[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) && items.length < limit) {
    const block = match[1] ?? '';
    const title = readTag(block, 'title');
    const link = readTag(block, 'link') || readAttr(block, 'link', 'href');
    if (!title || !link) continue;
    items.push({
      title,
      link,
      published: readTag(block, 'pubDate') || readTag(block, 'dc:date'),
      summary: readTag(block, 'description') || readTag(block, 'content:encoded')
    });
  }
  return items.map(cleanItem);
}

function parseAtom(xml: string, limit: number): RssItem[] {
  const items: RssItem[] = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(xml)) && items.length < limit) {
    const block = match[1] ?? '';
    const title = readTag(block, 'title');
    const link = readAttr(block, 'link', 'href') || readTag(block, 'id');
    if (!title || !link) continue;
    items.push({
      title,
      link,
      published: readTag(block, 'updated') || readTag(block, 'published'),
      summary: readTag(block, 'summary') || readTag(block, 'content')
    });
  }
  return items.map(cleanItem);
}

function readTag(block: string, tag: string) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag.split(':').pop()}>`, 'i');
  const match = block.match(re);
  if (!match?.[1]) return '';
  return decodeEntities(stripTags(match[1])).trim();
}

function readAttr(block: string, tag: string, attr: string) {
  const re = new RegExp(`<${tag}\\b[^>]*${attr}=["']([^"']+)["'][^>]*\\/?>`, 'i');
  return block.match(re)?.[1]?.trim() ?? '';
}

function stripTags(value: string) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').replace(/<[^>]+>/g, ' ');
}

function decodeEntities(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function cleanItem(item: RssItem): RssItem {
  const cleaned: RssItem = {
    title: item.title.replace(/\s+/g, ' ').trim(),
    link: item.link
  };
  if (item.published) cleaned.published = item.published;
  if (item.summary) {
    cleaned.summary = item.summary.replace(/\s+/g, ' ').trim().slice(0, 400);
  }
  return cleaned;
}
