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
