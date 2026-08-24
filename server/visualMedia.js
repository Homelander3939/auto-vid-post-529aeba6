const fetch = require('node-fetch');

const MAX_VISION_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VISION_IMAGES_PER_MESSAGE = 2;
const MAX_VISION_IMAGES_TOTAL = 4;

function assertSafeImageUrl(url) {
  const host = String(url?.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  const privateIpv4 = /^(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01])|169\.254)(?:\.|$)/.test(host);
  if (!['http:', 'https:'].includes(url?.protocol)) throw new Error('Only HTTP(S) image URLs are supported');
  if (url.protocol === 'http:' && !loopback) throw new Error('Remote image URLs must use HTTPS');
  if (!loopback && (privateIpv4 || host.endsWith('.local'))) throw new Error('Private-network image URLs are not allowed');
  return url;
}

function sniffImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  return null;
}

function validateImageBuffer(buffer, declaredType = '', maxBytes = MAX_VISION_IMAGE_BYTES) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Image is empty');
  if (buffer.length > maxBytes) throw new Error(`Image is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB local vision limit`);
  const mimeType = sniffImageMimeType(buffer);
  if (!mimeType) throw new Error('Unsupported or invalid image bytes; use JPEG, PNG, WebP, or GIF');
  const normalizedDeclared = String(declaredType || '').split(';')[0].trim().toLowerCase().replace('image/jpg', 'image/jpeg');
  if (normalizedDeclared && normalizedDeclared.startsWith('image/') && normalizedDeclared !== mimeType) {
    throw new Error(`Image content does not match its declared type (${normalizedDeclared})`);
  }
  return { buffer, mimeType, byteLength: buffer.length };
}

function parseImageDataUrl(value, maxBytes = MAX_VISION_IMAGE_BYTES) {
  const match = String(value || '').match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) throw new Error('Invalid image data URL');
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  return validateImageBuffer(buffer, match[1], maxBytes);
}

async function responseToValidatedImage(response, options = {}) {
  if (!response?.ok) throw new Error(`Image download failed with HTTP ${response?.status || 0}`);
  const maxBytes = Number(options.maxBytes || MAX_VISION_IMAGE_BYTES);
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > maxBytes) throw new Error(`Image is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB local vision limit`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return validateImageBuffer(buffer, response.headers?.get?.('content-type') || options.declaredType || '', maxBytes);
}

async function loadImageInput(input, options = {}) {
  const value = typeof input === 'string' ? input : input?.url;
  if (!value) throw new Error('Image URL is missing');
  if (String(value).startsWith('data:')) return parseImageDataUrl(value, options.maxBytes);
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('Image URL is invalid'); }
  assertSafeImageUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || 15_000));
  try {
    const response = await (options.fetchImpl || fetch)(url.toString(), {
      headers: { 'User-Agent': 'Local-Video-Uploader-Vision/1.0' },
      signal: controller.signal,
    });
    if (response?.url) assertSafeImageUrl(new URL(response.url));
    return await responseToValidatedImage(response, options);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Image download timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function imageToDataUrl(image) {
  return `data:${image.mimeType};base64,${image.buffer.toString('base64')}`;
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => String(part.text || '')).join('\n');
}

function imageInputsForMessage(message) {
  const direct = Array.isArray(message?.images) ? message.images : [];
  const files = Array.isArray(message?.files)
    ? message.files.filter((file) => file?.isImage || String(file?.type || '').startsWith('image/'))
    : [];
  const blocks = Array.isArray(message?.content)
    ? message.content.filter((part) => part?.type === 'image_url').map((part) => part.image_url)
    : [];
  return [...direct, ...files, ...blocks].filter((item) => typeof item === 'string' ? item : item?.url);
}

async function materializeVisionMessages(messages, options = {}) {
  const rows = Array.isArray(messages) ? messages : [];
  const output = [];
  let totalImages = 0;
  for (const [index, message] of rows.entries()) {
    const text = messageText(message?.content);
    const isUser = message?.role === 'user';
    const inputs = isUser ? imageInputsForMessage(message).slice(0, MAX_VISION_IMAGES_PER_MESSAGE) : [];
    const parts = text ? [{ type: 'text', text }] : [];
    for (const input of inputs) {
      if (totalImages >= MAX_VISION_IMAGES_TOTAL) break;
      try {
        const image = await loadImageInput(input, options);
        parts.push({ type: 'image_url', image_url: { url: imageToDataUrl(image) } });
        totalImages += 1;
      } catch (error) {
        const isLastUser = index === rows.length - 1;
        if (isLastUser && options.strictLastUser !== false) throw new Error(`Attached image could not be loaded: ${error.message}`);
        parts.push({ type: 'text', text: `[An earlier attached image is unavailable: ${error.message}]` });
      }
    }
    const clean = { ...message };
    delete clean.images;
    delete clean.files;
    clean.content = parts.some((part) => part.type === 'image_url') ? parts : text;
    output.push(clean);
  }
  return { messages: output, imageCount: totalImages };
}

function extractMarkdownImageUrls(text) {
  const urls = [];
  const seen = new Set();
  const pattern = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;
  for (const match of String(text || '').matchAll(pattern)) {
    if (!seen.has(match[1])) { seen.add(match[1]); urls.push(match[1]); }
  }
  return urls.slice(0, 4);
}

module.exports = {
  MAX_VISION_IMAGE_BYTES,
  assertSafeImageUrl,
  extractMarkdownImageUrls,
  imageToDataUrl,
  loadImageInput,
  materializeVisionMessages,
  messageText,
  parseImageDataUrl,
  responseToValidatedImage,
  sniffImageMimeType,
  validateImageBuffer,
};
