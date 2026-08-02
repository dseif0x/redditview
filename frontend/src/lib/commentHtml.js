// Renders reddit's server-side comment HTML (body_html) safely. Reddit's
// own renderer covers its full markdown flavor — tables, spoilers,
// superscript, code blocks, quotes — so sanitizing its output beats
// re-parsing markdown client-side and drifting from reddit's behavior.
//
// On top of sanitizing, media links render inline the way reddit's apps do:
// preview.redd.it / i.redd.it / giphy links become <img>, and media_metadata
// entries the HTML didn't already show (giphy gifs picked from the gif
// picker) are appended after the text.
import { mediaUrl } from './api.js';

const ALLOWED = new Set([
  'DIV', 'P', 'A', 'EM', 'STRONG', 'DEL', 'CODE', 'PRE', 'BLOCKQUOTE',
  'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'BR', 'SUP', 'SUB', 'SPAN', 'IMG',
]);
// Dropped wholesale, children included.
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'VIDEO', 'AUDIO', 'SVG', 'MATH', 'TEMPLATE']);

// Links that ARE an image: rendered inline instead of as a link.
const IMG_LINK = /^https:\/\/((preview|i)\.redd\.it|(media\d*|i)\.giphy\.com)\/[^?#]+\.(png|jpe?g|gif|webp)([?#]|$)/i;
// Giphy PAGE links (giphy.com/gifs/slug-<id>): the id resolves to the gif —
// via the comment's media_metadata entry when reddit provided one, else
// giphy's direct-file host.
const GIPHY_PAGE = /^https?:\/\/(?:www\.)?giphy\.com\/(?:gifs|embed|clips)\/(?:[\w-]*-)?([a-zA-Z0-9]+)\/?(?:[?#].*)?$/i;
// Sources allowed for <img> tags reddit itself emits (emotes etc.).
const IMG_SRC = /^https:\/\/[^/]*(redd\.it|redditmedia\.com|redditstatic\.com|giphy\.com)\//i;

// Dedupe key for a media URL: the filename (query-insensitive, so a
// media_metadata variant matches the body's differently-sized link), with
// the whole string as fallback for URLs that don't parse (data: URIs).
const fileOf = (u) => {
  try {
    return new URL(u).pathname.split('/').pop() || u;
  } catch {
    return u;
  }
};

function inlineImg(doc, url) {
  const img = doc.createElement('img');
  img.className = 'c-media';
  img.setAttribute('loading', 'lazy');
  img.setAttribute('src', mediaUrl(url));
  return img;
}

export function renderCommentHtml(bodyHtml, media = []) {
  if (!bodyHtml) return '';
  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html');
  const shown = new Set(); // media files already inlined by the body

  const sanitize = (parent) => {
    for (const el of [...parent.children]) {
      if (DROP.has(el.tagName)) {
        el.remove();
        continue;
      }
      sanitize(el);
      if (!ALLOWED.has(el.tagName)) {
        el.replaceWith(...el.childNodes); // unknown wrapper: keep its content
        continue;
      }
      const keepSpoiler = el.tagName === 'SPAN' && el.classList.contains('md-spoiler-text');
      const href = el.tagName === 'A' ? el.getAttribute('href') || '' : '';
      const src = el.tagName === 'IMG' ? el.getAttribute('src') || '' : '';
      for (const a of [...el.attributes]) el.removeAttribute(a.name);
      if (keepSpoiler) el.className = 'md-spoiler-text';

      if (el.tagName === 'A') {
        // r/… and u/… links come through relative
        const abs = href.startsWith('/') ? 'https://www.reddit.com' + href : href;
        if (!/^https?:\/\//i.test(abs)) {
          el.replaceWith(...el.childNodes);
          continue;
        }
        if (IMG_LINK.test(abs)) {
          shown.add(fileOf(abs));
          el.replaceWith(inlineImg(doc, abs));
          continue;
        }
        const giphy = abs.match(GIPHY_PAGE);
        if (giphy) {
          const entry = (media || []).find((m) => (m.id || '').includes(giphy[1]));
          const url = entry?.url || `https://i.giphy.com/${giphy[1]}.gif`;
          shown.add(fileOf(url));
          el.replaceWith(inlineImg(doc, url));
          continue;
        }
        el.setAttribute('href', abs);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener');
      } else if (el.tagName === 'IMG') {
        if (IMG_SRC.test(src)) {
          shown.add(fileOf(src));
          el.className = 'c-media';
          el.setAttribute('loading', 'lazy');
          el.setAttribute('src', mediaUrl(src));
        } else {
          el.remove();
        }
      }
    }
  };
  sanitize(doc.body);

  for (const m of media || []) {
    if (!m.url || shown.has(fileOf(m.url))) continue;
    doc.body.appendChild(inlineImg(doc, m.url));
  }
  return doc.body.innerHTML;
}
