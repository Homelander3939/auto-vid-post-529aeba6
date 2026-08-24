const { URL } = require('node:url');
const { createHash } = require('node:crypto');

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 'source',
]);

const REPUTABLE_NEWS_HOSTS = new Set([
  'apnews.com', 'arstechnica.com', 'bbc.com', 'bbc.co.uk', 'bloomberg.com',
  'cnbc.com', 'ft.com', 'nature.com', 'reuters.com', 'techcrunch.com',
  'theguardian.com', 'theverge.com', 'wired.com',
]);

const LOW_VALUE_HOST_PARTS = [
  'facebook.com', 'instagram.com', 'linkedin.com', 'pinterest.', 'reddit.com',
  'tiktok.com', 'x.com', 'youtube.com',
];

const IMAGE_REJECT = /(?:^|[\W_])(avatar|badge|blank|favicon|flag|icon|logo|mark|pixel|placeholder|profile|sprite|tracking|emoji)(?:[\W_]|$)|app[-_ ]?store|google[-_ ]?play|social[-_ ]?media[-_ ]?card|open[-_ ]?graph[-_ ]?card|generic[-_ ]?og/i;
const IMAGE_POSITIVE = /article|cover|hero|launch|media|news|photo|press|product|uploads|wp-content|cdn/i;
const PLACEHOLDER = /\[(?:insert|placeholder|title|image|photo|account)[^\]]*\]|\{(?:insert|placeholder|title|image|photo|account)[^}]*\}|<placeholder>|lorem ipsum/i;

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code) || 32));
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!/^https?:$/.test(parsed.protocol)) return '';
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    if (parsed.pathname !== '/') parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch {
    return '';
  }
}

function hostnameOf(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function baseHost(value) {
  const host = hostnameOf(value);
  const parts = host.split('.').filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('.') : host;
}

function relevantTokens(value) {
  const stop = new Set([
    'about', 'after', 'again', 'also', 'from', 'have', 'latest', 'news', 'that',
    'their', 'there', 'these', 'this', 'today', 'what', 'when', 'where', 'which',
    'with', 'would',
  ]);
  return [...new Set(String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/).filter((token) => token.length >= 3 && !stop.has(token)))];
}

function claimNumbers(value) {
  return [...new Set(String(value || '').match(/\b\d[\d,.:%+-]*\b/g) || [])]
    .map((number) => number.replace(/[,.](?=\d{3}(?:\D|$))/g, '').toLowerCase());
}

function claimNames(value) {
  const text = String(value || '');
  const names = [];
  for (const match of text.matchAll(/(?:\b[A-Z][\p{L}\p{N}&.'’-]{2,})(?:\s+[A-Z][\p{L}\p{N}&.'’-]{1,})*/gu)) {
    const candidate = match[0].trim();
    if (!/^(?:The|This|That|These|Those|According|However|Meanwhile|Today|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i.test(candidate)) {
      names.push(candidate.toLowerCase());
    }
  }
  return [...new Set(names)].slice(0, 8);
}

function normalizedEvidenceText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[,.](?=\d{3}(?:\D|$))/g, '')
    .replace(/[^\p{L}\p{N}%:+&.'’-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreSource(source, query = '', now = new Date()) {
  const url = normalizeUrl(source?.url);
  if (!url) return -1000;
  const host = hostnameOf(url);
  const haystack = `${source?.title || ''} ${source?.snippet || ''} ${source?.content || ''}`.toLowerCase();
  const path = new URL(url).pathname.toLowerCase();
  let score = 50;

  if (url.startsWith('https://')) score += 3;
  if (/\.(gov|edu)(\.|$)/i.test(host)) score += 22;
  if (/\/(?:docs?|documentation|developers?|newsroom|press|research|blog|announcements?)\b/i.test(path)) score += 12;
  if (REPUTABLE_NEWS_HOSTS.has(host) || REPUTABLE_NEWS_HOSTS.has(baseHost(url))) score += 18;
  if (LOW_VALUE_HOST_PARTS.some((part) => host.includes(part))) score -= 18;
  if (/\/(?:search|tag|tags|category|author|login|signup)(?:\/|$)/i.test(path)) score -= 16;
  if (String(source?.snippet || '').length >= 100) score += 5;
  if (String(source?.content || '').length >= 600) score += 18;
  if (source?.reachable === true) score += 15;
  if (source?.reachable === false) score -= 40;

  const overlap = relevantTokens(query).filter((token) => haystack.includes(token)).length;
  score += Math.min(24, overlap * 4);

  if (source?.publishedAt) {
    const published = new Date(source.publishedAt);
    const days = (now.getTime() - published.getTime()) / 86_400_000;
    if (Number.isFinite(days) && days >= -2) {
      if (days <= 7) score += 15;
      else if (days <= 45) score += 9;
      else if (days > 730) score -= 8;
    }
  }

  return score;
}

function selectDiverseSources(sources, { query = '', max = 8, maxPerHost = 2 } = {}) {
  const byUrl = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    const url = normalizeUrl(source?.url);
    if (!url) continue;
    const candidate = { ...source, url };
    const current = byUrl.get(url);
    if (!current || scoreSource(candidate, query) > scoreSource(current, query)) byUrl.set(url, candidate);
  }

  const hostCounts = new Map();
  const selected = [];
  for (const source of [...byUrl.values()].sort((a, b) => scoreSource(b, query) - scoreSource(a, query))) {
    const host = baseHost(source.url);
    const count = hostCounts.get(host) || 0;
    if (count >= maxPerHost) continue;
    hostCounts.set(host, count + 1);
    selected.push({ ...source, qualityScore: scoreSource(source, query) });
    if (selected.length >= max) break;
  }
  return selected;
}

function firstMeta(html, keys) {
  const text = String(html || '');
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`<meta\\b[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i'),
      new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${escaped}["'][^>]*>`, 'i'),
    ];
    for (const pattern of patterns) {
      const found = text.match(pattern)?.[1];
      if (found) return decodeHtml(found).trim();
    }
  }
  return '';
}

function absoluteUrl(value, pageUrl) {
  try {
    const result = new URL(decodeHtml(value), pageUrl);
    return /^https?:$/.test(result.protocol) ? result.toString() : '';
  } catch { return ''; }
}

function attributesOf(tag) {
  const attrs = {};
  for (const match of String(tag || '').matchAll(/([\w:-]+)\s*=\s*(?:["']([^"']*)["']|([^\s>]+))/g)) {
    attrs[String(match[1]).toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

function extractPageMetadata(html, pageUrl) {
  const raw = String(html || '');
  const cleaned = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  const article = cleaned.match(/<article\b[\s\S]*?<\/article>/i)?.[0]
    || cleaned.match(/<main\b[\s\S]*?<\/main>/i)?.[0]
    || cleaned;
  const content = decodeHtml(article.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 6500);
  const title = firstMeta(raw, ['og:title', 'twitter:title'])
    || decodeHtml(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
  const description = firstMeta(raw, ['description', 'og:description', 'twitter:description']);
  const publishedAt = firstMeta(raw, [
    'article:published_time', 'datePublished', 'date', 'pubdate', 'publish-date', 'sailthru.date',
  ]);

  const images = [];
  const seen = new Set();
  const addImage = (candidate) => {
    const url = absoluteUrl(candidate.url, pageUrl);
    if (!url || seen.has(url) || IMAGE_REJECT.test(`${url} ${candidate.alt || ''}`)) return;
    seen.add(url);
    images.push({ ...candidate, url, pageUrl, title });
  };
  const metaImage = firstMeta(raw, ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']);
  if (metaImage) addImage({ url: metaImage, source: 'source-page-meta', alt: firstMeta(raw, ['og:image:alt', 'twitter:image:alt']) });
  for (const tag of raw.match(/<img\b[^>]*>/gi) || []) {
    const attrs = attributesOf(tag);
    const src = attrs.src || attrs['data-src'] || attrs['data-lazy-src'] || attrs['data-original'];
    if (!src) continue;
    const width = Number.parseInt(attrs.width || '0', 10) || 0;
    const height = Number.parseInt(attrs.height || '0', 10) || 0;
    if ((width && width < 320) || (height && height < 180)) continue;
    addImage({ url: src, source: 'source-page-dom', alt: attrs.alt || '', width, height });
    if (images.length >= 12) break;
  }

  return { title, description, publishedAt, content, images };
}

function imageDimensions(buffer, contentType = '') {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (bytes.length < 24) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), format: 'png' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5), format: 'jpeg' };
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (!Number.isFinite(length) || length < 2) break;
      offset += length + 2;
    }
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    const kind = bytes.subarray(12, 16).toString('ascii');
    if (kind === 'VP8X' && bytes.length >= 30) {
      return {
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
        format: 'webp',
      };
    }
  }
  if (bytes.subarray(0, 3).toString('ascii') === 'GIF' && bytes.length >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), format: 'gif' };
  }
  if (/image\/(?:jpeg|jpg|png|webp)/i.test(contentType)) return { width: 0, height: 0, format: contentType.split('/')[1] };
  return null;
}

function scoreImageCandidate(candidate, prompt = '') {
  const url = String(candidate?.url || '');
  const haystack = `${url} ${candidate?.alt || ''} ${candidate?.title || ''}`.toLowerCase();
  if (!url || IMAGE_REJECT.test(haystack) || /\.(?:svg|ico)(?:\?|$)/i.test(url)) return -1000;
  let score = candidate?.source === 'source-page-meta' ? 80 : candidate?.source === 'source-page-dom' ? 62 : 35;
  if (candidate?.pageUrl) score += 18;
  if (IMAGE_POSITIVE.test(haystack)) score += 12;
  const width = Number(candidate?.width || 0);
  const height = Number(candidate?.height || 0);
  if (width && height) {
    const area = width * height;
    if (area >= 1_000_000) score += 28;
    else if (area >= 400_000) score += 16;
    else if (area < 120_000) score -= 50;
    const ratio = width / height;
    if (ratio >= 1.15 && ratio <= 2.2) score += 10;
  }
  const overlap = relevantTokens(prompt).filter((token) => haystack.includes(token)).length;
  score += Math.min(30, overlap * 6);
  return score;
}

function validateImageBytes(buffer, { contentType = '', candidate = null } = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (bytes.length < 25_000) return { ok: false, reason: 'image_too_small_bytes' };
  if (bytes.length > 12 * 1024 * 1024) return { ok: false, reason: 'image_too_large' };
  if (contentType && !/^image\/(?:jpeg|jpg|png|webp)$/i.test(contentType.split(';')[0].trim())) {
    return { ok: false, reason: 'unsupported_image_type' };
  }
  const dimensions = imageDimensions(bytes, contentType);
  if (!dimensions) return { ok: false, reason: 'invalid_image_bytes' };
  const width = dimensions.width || Number(candidate?.width || 0);
  const height = dimensions.height || Number(candidate?.height || 0);
  if (width && height && (width < 640 || height < 360 || width * height < 300_000)) {
    return { ok: false, reason: 'image_dimensions_too_small', width, height };
  }
  return { ok: true, width, height, format: dimensions.format, bytes: bytes.length };
}

function validateVariant(platform, variant) {
  const description = String(variant?.description || '').replace(/\r/g, '').trim();
  const hashtags = [...new Set((Array.isArray(variant?.hashtags) ? variant.hashtags : [])
    .map((tag) => String(tag || '').replace(/^#+/, '').replace(/[^\p{L}\p{N}_-]/gu, '').trim())
    .filter(Boolean))].slice(0, 8);
  const key = String(platform || '').toLowerCase();
  const limits = { x: 278, twitter: 278, linkedin: 2200, facebook: 1800, instagram: 1800, tiktok: 1000 };
  const errors = [];
  const renderedHashtags = hashtags.length ? `\n\n#${hashtags.join(' #')}` : '';
  const renderedLength = `${description}${renderedHashtags}`.length;
  if (description.length < (key === 'x' || key === 'twitter' ? 45 : 100)) errors.push('too_short');
  if (renderedLength > (limits[key] || 1800)) errors.push('too_long_with_hashtags');
  if (/https?:\/\//i.test(description)) errors.push('raw_url');
  if (PLACEHOLDER.test(description)) errors.push('placeholder');
  if (/^\s*(?:[-*•]|\d+\.)\s+/m.test(description)) errors.push('headline_list');
  return { ok: errors.length === 0, errors, renderedLength, variant: { description, hashtags } };
}

function fitVariantToLimit(platform, variant) {
  const key = String(platform || '').toLowerCase();
  const limits = { x: 278, twitter: 278, linkedin: 2200, facebook: 1800, instagram: 1800, tiktok: 1000 };
  const limit = limits[key] || 1800;
  let hashtags = [...new Set((Array.isArray(variant?.hashtags) ? variant.hashtags : [])
    .map((tag) => String(tag || '').replace(/^#+/, '').replace(/[^\p{L}\p{N}_-]/gu, '').trim())
    .filter(Boolean))].slice(0, key === 'x' || key === 'twitter' ? 4 : 8);
  let description = String(variant?.description || '')
    .replace(/\r/g, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  let suffix = hashtags.length ? `\n\n#${hashtags.join(' #')}` : '';

  while (hashtags.length > 2 && suffix.length > Math.floor(limit * 0.26)) {
    hashtags = hashtags.slice(0, -1);
    suffix = `\n\n#${hashtags.join(' #')}`;
  }
  const available = Math.max(40, limit - suffix.length);
  if (description.length > available) {
    const sentences = description.match(/[^.!?]+[.!?]+(?:["'”’)]*)|[^.!?]+$/g) || [description];
    let selected = '';
    for (const sentence of sentences) {
      const next = `${selected}${selected ? ' ' : ''}${sentence.trim()}`.trim();
      if (next.length > available) break;
      selected = next;
    }
    if (!selected || selected.length < 45) {
      const raw = description.slice(0, Math.max(1, available - 1));
      const boundary = raw.lastIndexOf(' ');
      selected = `${raw.slice(0, boundary > 40 ? boundary : raw.length).replace(/[,:;\-\s]+$/, '')}…`;
    }
    description = selected.trim();
  }
  return { description, hashtags };
}

function sourceQualityGate(sources) {
  const readable = (Array.isArray(sources) ? sources : []).filter((source) => source?.reachable && String(source?.content || '').length >= 400);
  const hosts = new Set(readable.map((source) => baseHost(source.url)).filter(Boolean));
  const errors = [];
  if (readable.length < 2) errors.push('fewer_than_two_reachable_sources');
  if (hosts.size < 2) errors.push('fewer_than_two_independent_domains');
  return { ok: errors.length === 0, errors, readableCount: readable.length, independentDomains: hosts.size };
}

function exactSupportingSpan(claim, sourceText) {
  const tokens = relevantTokens(claim);
  if (!tokens.length) return '';
  const requiredNumbers = claimNumbers(claim);
  const requiredNames = claimNames(claim);
  const sentences = String(sourceText || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9“"'])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 35 && sentence.length <= 700);
  let best = { sentence: '', score: 0, coverage: 0 };
  for (const sentence of sentences) {
    const normalized = normalizedEvidenceText(sentence);
    const score = tokens.filter((token) => normalized.includes(normalizedEvidenceText(token))).length;
    const coverage = score / tokens.length;
    const hasEveryNumber = requiredNumbers.every((number) => normalized.includes(number));
    const matchedNames = requiredNames.filter((name) => normalized.includes(normalizedEvidenceText(name))).length;
    const hasNames = requiredNames.length === 0 || matchedNames >= Math.min(2, requiredNames.length);
    if (!hasEveryNumber || !hasNames) continue;
    if (coverage > best.coverage || (coverage === best.coverage && score > best.score)) {
      best = { sentence, score, coverage };
    }
  }
  const minimum = Math.max(2, Math.min(5, Math.ceil(tokens.length * 0.45)));
  return best.score >= minimum && best.coverage >= 0.4 ? best.sentence.slice(0, 700) : '';
}

function groundFactsToSources(facts, sources) {
  const sourceRows = Array.isArray(sources) ? sources : [];
  return (Array.isArray(facts) ? facts : []).map((fact, index) => {
    const claim = String(fact?.claim || '').replace(/\s+/g, ' ').trim();
    const references = [...new Set((Array.isArray(fact?.sourceIds) ? fact.sourceIds : [])
      .map(Number).filter((id) => Number.isInteger(id) && id >= 1 && id <= sourceRows.length))]
      .map((id) => {
        const source = sourceRows[id - 1];
        const span = exactSupportingSpan(claim, source?.content || source?.snippet || '');
        return span ? { sourceId: id, url: source.url, span } : null;
      })
      .filter(Boolean);
    return {
      id: `F${index + 1}`,
      claim,
      sourceIds: references.map((reference) => reference.sourceId),
      sourceUrls: references.map((reference) => reference.url),
      supportingSpans: references,
      confidence: fact?.confidence === 'medium' ? 'medium' : 'high',
      verified: claim.length >= 20 && references.length > 0,
    };
  }).filter((fact) => fact.verified);
}

function sourceRole(source, index) {
  const host = hostnameOf(source?.url);
  const pathname = (() => { try { return new URL(source.url).pathname.toLowerCase(); } catch { return ''; } })();
  if (/\.(?:gov|edu)(?:\.|$)/i.test(host)
    || /\/(?:press|newsroom|announcements?|docs?|documentation|research|blog)(?:\/|$)/i.test(pathname)) return 'primary';
  return index === 0 ? 'anchor' : 'independent';
}

function buildEvidencePacket({ query = '', sources = [], facts = [], images = [], uncertainties = [], requireImage = false } = {}) {
  const selectedSources = selectDiverseSources(sources, { query, max: 8, maxPerHost: 2 });
  const groundedFacts = facts.length && facts[0]?.supportingSpans
    ? facts.filter((fact) => fact?.verified !== false && fact?.sourceUrls?.length)
    : groundFactsToSources(facts, selectedSources);
  const normalizedImages = (Array.isArray(images) ? images : []).filter((image) => image?.url && image?.validated !== false).map((image) => ({
    url: image.url,
    source_url: image.sourceUrl || image.pageUrl || image.url,
    mime: image.contentType || image.mime || '',
    width: Number(image.width || 0),
    height: Number(image.height || 0),
    bytes: Number(image.bytes || image.byteLength || 0),
    score: Number(image.score || scoreImageCandidate(image, query)),
    validated: image.validated !== false,
  }));
  const sourceGate = sourceQualityGate(selectedSources);
  const errors = [...sourceGate.errors];
  if (groundedFacts.length < 3) errors.push('fewer_than_three_source_span_facts');
  if (requireImage && normalizedImages.length === 0) errors.push('missing_verified_image');
  const anchor = selectedSources[0] || null;
  const topicId = createHash('sha256').update(`${String(query).trim().toLowerCase()}|${anchor?.url || ''}`).digest('hex').slice(0, 20);
  return {
    version: 1,
    topic_id: topicId,
    query: String(query || '').trim(),
    created_at: new Date().toISOString(),
    anchor: anchor ? {
      title: anchor.title || '',
      url: anchor.url,
      publisher: hostnameOf(anchor.url),
      published_at: anchor.publishedAt || null,
    } : null,
    sources: selectedSources.map((source, index) => ({
      id: index + 1,
      url: source.url,
      domain: baseHost(source.url),
      title: source.title || '',
      published_at: source.publishedAt || null,
      readable_text: String(source.content || '').slice(0, 6500),
      role: sourceRole(source, index),
      quality_score: Number(source.qualityScore || scoreSource(source, query)),
    })),
    facts: groundedFacts.map((fact) => ({
      id: fact.id,
      claim: fact.claim,
      source_urls: fact.sourceUrls,
      supporting_spans: fact.supportingSpans,
      confidence: fact.confidence,
    })),
    images: normalizedImages,
    uncertainties: (Array.isArray(uncertainties) ? uncertainties : [uncertainties]).map(String).filter(Boolean),
    quality: {
      readable_sources: sourceGate.readableCount,
      independent_domains: sourceGate.independentDomains,
      grounded_facts: groundedFacts.length,
      verified_images: normalizedImages.length,
      errors,
      passed: errors.length === 0,
    },
  };
}

function validateResearchReport(report, evidencePacket = {}, options = {}) {
  const text = String(report || '').trim();
  const minChars = Math.max(120, Number(options.minChars || 500));
  const errors = [];
  if (text.length < minChars) errors.push('report_too_short');
  if (PLACEHOLDER.test(text)) errors.push('placeholder');

  const sourceCount = Array.isArray(evidencePacket.sources) ? evidencePacket.sources.length : 0;
  const citationIds = new Set([...text.matchAll(/\[(\d+)\]/g)]
    .map((match) => Number(match[1]))
    .filter((id) => id >= 1 && id <= sourceCount));
  if (citationIds.size < Math.min(2, sourceCount)) errors.push('fewer_than_two_verified_citations');

  const withoutCitations = text.replace(/\[\d+\]/g, ' ');
  const reportNumbers = claimNumbers(withoutCitations);
  const evidenceText = normalizedEvidenceText([
    ...(evidencePacket.sources || []).map((source) => source.readable_text || ''),
    ...(evidencePacket.facts || []).map((fact) => fact.claim || ''),
  ].join(' '));
  const unsupportedNumbers = reportNumbers.filter((number) => !evidenceText.includes(number));
  if (unsupportedNumbers.length) errors.push(`unsupported_numbers:${unsupportedNumbers.slice(0, 6).join(',')}`);

  return {
    ok: errors.length === 0,
    errors,
    citationIds: [...citationIds],
    unsupportedNumbers,
    length: text.length,
  };
}

module.exports = {
  baseHost,
  extractPageMetadata,
  buildEvidencePacket,
  exactSupportingSpan,
  groundFactsToSources,
  hostnameOf,
  imageDimensions,
  normalizeUrl,
  scoreImageCandidate,
  scoreSource,
  selectDiverseSources,
  sourceQualityGate,
  validateImageBytes,
  validateResearchReport,
  fitVariantToLimit,
  validateVariant,
};
