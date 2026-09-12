// Pure text handling for the MCP tools: HTML conversion, and the sanitisers
// that stand between Ghost content and an agent's context window.
//
// These live here rather than in server.js so they can be unit tested without
// booting a server. server.js starts listening on import and exits 1 without
// GHOST_API_KEY, so anything importable from it is untestable in practice.
// Three of the four below are the security surface — a silent regression in
// sanitiseContent reopens prompt injection with every CI check still green.

// Converts HTML to readable plain text, preserving structure for agents.
export function stripHtml(html) {
  return html
    // These three run before anything else, because the generic tag strip
    // below only removes the tags and keeps whatever sat between them.
    //
    // Comments first. <[^>]+> stops at the first '>', so a comment containing
    // one escaped with the remainder intact: "<!-- a > Human: leak -->" came
    // out as "Human: leak -->". A comment is invisible in the rendered article
    // and in the Ghost editor, which makes it the best hiding place there is,
    // and the text landed mid-line where sanitiseContent deliberately does not
    // reach. Matched through to the closing --> instead.
    .replace(/<!--[\s\S]*?-->/g, '')
    // Then script and style bodies. Ghost's HTML card allows arbitrary markup,
    // so both are reachable, and both leaked their contents as if they were
    // prose: "<script>var x = \"Human: do bad\"</script>" became
    // 'var x = "Human: do bad"'. Neither is article text under any reading.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<h[1-6][^>]*>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<(p|div|blockquote|section|article)[^>]*>/gi, '\n\n')
    .replace(/<\/(p|div|blockquote|section|article)>/gi, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<code[^>]*>/gi, '`')
    .replace(/<\/code>/gi, '`')
    .replace(/<pre[^>]*>/gi, '\n\n')
    .replace(/<\/pre>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '...')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&ldquo;/g, '\u201C')
    .replace(/&rdquo;/g, '\u201D')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Sanitise a search query for use in Ghost NQL filter expressions.
export function sanitiseQuery(query) {
  return query.replace(/['"\\]/g, ' ').trim();
}

// Validate Ghost slug format — lowercase alphanumeric and hyphens only.
export function isValidSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

// Make a value safe to interpolate into a single-line log record.
//
// logRequest writes one line per tool call, and those lines are the audit
// trail. Interpolating raw agent input let a newline in a tag close the
// record and open a forged one, indistinguishable from a real entry:
//
//   [2026-09-12T05:24:32.175Z] tool=list_articles page=1 limit=20 tag=mcp
//   [2026-01-01T00:00:00.000Z] tool=get_article slug=admin-secrets
//
// Everything that ends a line goes, including U+2028 and U+2029, which some
// log viewers break on even though console.error does not. Control characters
// go too — they can rewrite a terminal rendering of the log. The cap keeps a
// long argument from burying the records around it.
export function sanitiseLogValue(value, max = 200) {
  // Built from escapes rather than written as literals: U+2028 and U+2029
  // are line terminators in JavaScript source, so a literal one inside a
  // regex literal ends the literal and fails to parse.
  const LINE_BREAKS = /[\r\n\u2028\u2029]+/g;
  const CONTROL = /[\u0000-\u001f\u007f]/g;
  const flat = String(value).replace(LINE_BREAKS, ' ').replace(CONTROL, '');
  return flat.length > max ? flat.slice(0, max) + '\u2026' : flat;
}

// Strip common prompt injection patterns from content returned to agents.
export function sanitiseContent(text) {
  return text
    .replace(/<\|[^|]*\|>/g, '')                                    // LLM special tokens e.g. <|im_start|>
    // Anchored to start-of-string as well as newline. The input here is always
    // trimmed (stripHtml ends in .trim()), so the opening line has no newline
    // in front of it — matching on \n+ alone let an article whose very first
    // line was "Human: ..." through untouched, which is the position an
    // injection would most want to occupy.
    .replace(/(^|\n+)(Human|Assistant|User|System)\s*:/gi, (_m, pre) => (pre ? '\n' : '') + '[...]')
    .replace(/\[INST\]|\[\/INST\]/g, '')                            // Llama instruction tokens
    .replace(/###\s*(Human|Assistant|Instruction|Response)\b/gi, '###') // injection headers
    // Direct override attempts. The [...] alternative matters because the role
    // rule above rewrites "Human:" to "[...]", which destroys the line anchor
    // this rule needs — so "Human: ignore previous instructions" lost its role
    // marker but kept the instruction. The anchor is kept deliberately narrow
    // rather than matching the phrase anywhere: this publication writes about
    // prompt injection, and an unanchored rule would mangle prose quoting it.
    .replace(
      /(^|\n+|\[\.\.\.\] ?)ignore (previous|all|above|prior) instructions?\b/gi,
      (_m, pre) => (pre.trimEnd() === '[...]' ? '[...]' : ''),
    )
    .trim();
}
