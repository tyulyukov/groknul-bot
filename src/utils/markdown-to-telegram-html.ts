const escapeHtml = (input: string): string =>
  input
    .replaceAll(/&/g, '&amp;')
    .replaceAll(/</g, '&lt;')
    .replaceAll(/>/g, '&gt;');

const escapeHtmlAttribute = (input: string): string =>
  escapeHtml(input).replaceAll(/"/g, '&quot;');

export const markdownToTelegramHtml = (markdown: string): string => {
  if (!markdown) return '';

  // 1) Extract fenced code blocks to placeholders
  const codeBlockPattern = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
  const codeBlocks: { placeholder: string; html: string }[] = [];
  let codeBlockIndex = 0;
  let text = markdown.replace(
    codeBlockPattern,
    (_m, langRaw: string, code: string) => {
      const language = String(langRaw || '').toLowerCase();
      const placeholder = `__CODE_BLOCK_${codeBlockIndex++}__`;
      const escaped = escapeHtml(code);
      const langAttr = language
        ? ` language="${escapeHtmlAttribute(language)}"`
        : '';
      const html = `<pre${langAttr}>${escaped}</pre>`;
      codeBlocks.push({ placeholder, html });
      return placeholder;
    },
  );

  // 2) Extract inline code to placeholders
  const inlineCodePattern = /`([^`\n]+)`/g;
  const inlineCodes: { placeholder: string; html: string }[] = [];
  let inlineCodeIndex = 0;
  text = text.replace(inlineCodePattern, (_m, code: string) => {
    const placeholder = `__INLINE_CODE_${inlineCodeIndex++}__`;
    const html = `<code>${escapeHtml(code)}</code>`;
    inlineCodes.push({ placeholder, html });
    return placeholder;
  });

  // 3) Escape HTML in the rest
  text = escapeHtml(text);

  // 4) Links [text](url)
  text = text.replace(
    /\[([^\]\n]+)\]\(([^\)\s]+)\)/g,
    (_m, label: string, url: string) => {
      const safeLabel = label.trim();
      const safeUrl = url.trim();
      return `<a href="${escapeHtmlAttribute(safeUrl)}">${escapeHtml(safeLabel)}</a>`;
    },
  );

  // 5) Bold: **text**
  text = text.replace(
    /\*\*([^*\n][\s\S]*?)\*\*/g,
    (_m, inner: string) => `<b>${inner}</b>`,
  );

  // 6) Underline: __text__
  text = text.replace(
    /__([^_\n][\s\S]*?)__/g,
    (_m, inner: string) => `<u>${inner}</u>`,
  );

  // 7) Italic: *text* or _text_
  // avoid matching inside HTML tags; our tags only contain letters and angle brackets, so this is acceptable
  text = text.replace(
    /(^|[\s(\[])\*([^*\n][^*]*?)\*(?=$|[\s)\]\.!?,;:])/g,
    (_m, p1: string, inner: string) => `${p1}<i>${inner}</i>`,
  );
  text = text.replace(
    /(^|[\s(\[])_([^_\n][^_]*?)_(?=$|[\s)\]\.!?,;:])/g,
    (_m, p1: string, inner: string) => `${p1}<i>${inner}</i>`,
  );

  // 8) Strikethrough: ~~text~~
  text = text.replace(
    /~~([^~\n][\s\S]*?)~~/g,
    (_m, inner: string) => `<s>${inner}</s>`,
  );

  // 9) Simple headings: convert leading # to bold line
  text = text.replace(
    /^(#{1,6})\s+(.+)$/gm,
    (_m, _hashes: string, title: string) => `<b>${title}</b>`,
  );

  // 10) Restore inline code
  inlineCodes.forEach(({ placeholder, html }) => {
    text = text.replaceAll(placeholder, html);
  });

  // 11) Restore code blocks
  codeBlocks.forEach(({ placeholder, html }) => {
    text = text.replaceAll(placeholder, html);
  });

  return text;
};
