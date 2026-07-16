// src/drafting/pattern-suggest.ts
//
// Suggest deterministic patterns from a "PASS if ... FAIL otherwise." rule.
//
// The hard limit, stated plainly: patterns can only ever be NECESSARY
// conditions, never sufficient ones. A rule like "PASS if the output evaluates
// Helix against §742.4 and states it is within scope" mentions §742.4 - so if
// §742.4 never appears, the rule cannot possibly be met, and failing without
// calling the model is sound and cheap. But the presence of §742.4 does NOT
// mean the rule is met: the document could say Helix is OUT of scope, which the
// rule's own explanation calls a FAIL. A regex cannot tell those apart.
//
// So every suggestion is a REQUIRED pattern wired for HYBRID assessment: the
// pattern is a fast fail-closed pre-check, and the LLM judge still decides the
// semantic question. And every suggestion is a PROPOSAL - it is returned to the
// editor for a human to accept, never written silently. A regex nobody reviewed
// that lands in the deterministic layer mis-scores every future document while
// looking authoritative, which is the one thing that layer must never do.

export interface PatternSuggestion {
  /** The literal token to require, as a regex source. */
  pattern: string;
  /** Human label for the report. */
  label: string;
  /** Why it is a safe NECESSARY condition - shown to the author before they accept. */
  rationale: string;
}

// Tokens that read as distinctive identifiers: clause numbers (§742.4, 3A090),
// standard refs (ISO 14971), part-like codes (XCKU5P). Deliberately narrow -
// suggesting a common English word as a required pattern would fail documents
// that phrase the same fact differently, which is worse than suggesting nothing.
const IDENTIFIER_PATTERNS: { re: RegExp; kind: string }[] = [
  { re: /§\s?\d+(?:\.\d+)*/g, kind: "regulatory clause" },
  { re: /\b\d[A-Z]\d{3}[A-Za-z0-9.]*\b/g, kind: "export-control classification" }, // 3A090, 4A090.x
  { re: /\bISO\s?\d{3,5}(?:-\d+)?\b/g, kind: "ISO standard" },
  { re: /\bIEC\s?\d{3,5}(?:-\d+)?\b/g, kind: "IEC standard" },
  { re: /\b[A-Z]{2,}[A-Z0-9]*\d[A-Z0-9]*\b/g, kind: "part or model code" }, // XCKU5P, DDR5
];

/**
 * Propose required patterns for a criterion rule. Returns [] when nothing in the
 * rule is a safe literal to require - which is the right answer for a purely
 * semantic rule like "written unambiguously", and the function says so by
 * staying silent rather than inventing a pattern.
 */
export function suggestPatterns(criterion: string): PatternSuggestion[] {
  // Only look at the "PASS if <condition>" clause - the "FAIL otherwise" tail
  // carries no tokens worth requiring.
  const passClause = /PASS if\s+([\s\S]*?)\.\s*FAIL otherwise\.?/i.exec(criterion)?.[1] ?? criterion;

  const seen = new Set<string>();
  const out: PatternSuggestion[] = [];

  for (const { re, kind } of IDENTIFIER_PATTERNS) {
    for (const m of passClause.matchAll(re)) {
      const literal = m[0].trim();
      const key = literal.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        // Escape regex metacharacters - the token is matched literally.
        pattern: literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        label: literal,
        rationale:
          `The rule names the ${kind} "${literal}". If it never appears in the output the rule cannot be met, ` +
          `so this is a safe necessary condition to fail on. It is NOT sufficient - the judge still decides ` +
          `whether the rule is actually satisfied - so accept it only as a HYBRID pre-check.`,
      });
    }
  }

  return out;
}
