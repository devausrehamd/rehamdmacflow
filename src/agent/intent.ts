// src/agent/intent.ts
//
// Deterministic intent resolution: user language -> document type.
//
// This is the ONE nondeterministic decision in an otherwise deterministic
// pipeline, and it chooses which deterministic path runs. A wrong resolution
// selects the wrong recipe, the wrong rubric, and the wrong required sources -
// silently and totally. So it is resolved by EXACT alias match, never by
// similarity, and ambiguity is SURFACED rather than guessed.
//
// The alias table lives in the rubric files, which means one registry per
// document type: if you can evaluate it you can draft it, and here is what
// people call it. No second source of truth to drift.
//
// The aliases are domain knowledge and are authored by domain experts. Under
// ISO 14971 "hazard", "risk" and "harm" are distinct terms; a Risk Register is
// a record while a DFMEA is an analysis. Conflating them here to be helpful
// would bake a domain error into config, permanently and invisibly.

import { getRubric, listRubricTypes } from "../drafting/rubric-loader.js";

/** Verbs that signal a request to PRODUCE a document rather than ask about one. */
const DRAFT_VERB_RE =
  /\b(draft|write|create|generate|produce|prepare|author|issue|raise)\b/i;

/**
 * Hedged premises. "I think there are issues" is a hypothesis, not a finding.
 * Drafting a controlled document on an unverified premise produces a defective
 * record that passes review, because the reviewer holds the same assumption.
 */
const PREMISE_RE =
  /\b(i think|i believe|it seems|it looks like|i suspect|possibly|might be|may be)\b/i;

export interface AliasIndex {
  /** normalised alias -> documentType */
  byAlias: Map<string, string>;
}

let index: AliasIndex | null = null;

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Drop the alias index so it is rebuilt from the current rubrics.
 *
 * This index is derived from the rubric set, so anything that reloads rubrics
 * MUST reset it too. Forgetting would be quiet and nasty: a newly released
 * document type would exist in the loader but be unrecognisable to the
 * classifier, so a request naming it would fall through as an ordinary
 * question rather than being routed to its recipe.
 */
export function resetAliasIndex(): void {
  index = null;
}

/** Build the alias index from every registered rubric. Cached. */
export function buildAliasIndex(): AliasIndex {
  if (index) return index;

  const byAlias = new Map<string, string>();
  for (const type of listRubricTypes()) {
    const { rubric } = getRubric(type);

    // The type itself is always an alias.
    const candidates = [rubric.documentType, ...rubric.aliases];
    for (const raw of candidates) {
      const key = normalise(raw);
      if (key.length === 0) continue;
      const existing = byAlias.get(key);
      if (existing && existing !== type) {
        throw new Error(
          `Alias "${raw}" is claimed by both '${existing}' and '${type}'. ` +
            `An ambiguous alias would silently select the wrong recipe.`,
        );
      }
      byAlias.set(key, type);
    }
  }

  index = { byAlias };
  return index;
}

export interface AliasMatch {
  documentType: string;
  matchedAlias: string;
}

/**
 * Every document type named anywhere in the question, by exact alias match on
 * word boundaries. Returns each type once, in the order first mentioned.
 *
 * Deliberately NOT fuzzy. "risk analysis" does not match "risk register".
 */
export function findDocumentTypes(question: string): AliasMatch[] {
  const { byAlias } = buildAliasIndex();
  const haystack = ` ${normalise(question)} `;

  const found: AliasMatch[] = [];
  const seen = new Set<string>();

  // Longest aliases first, so "design fmea" wins over a bare "fmea" alias.
  const aliases = [...byAlias.keys()].sort((a, b) => b.length - a.length);

  for (const alias of aliases) {
    if (!haystack.includes(` ${alias} `)) continue;
    const type = byAlias.get(alias)!;
    if (seen.has(type)) continue;
    seen.add(type);
    found.push({ documentType: type, matchedAlias: alias });
  }

  // Order by first mention in the question, not by alias length.
  found.sort((a, b) => haystack.indexOf(` ${a.matchedAlias} `) - haystack.indexOf(` ${b.matchedAlias} `));
  return found;
}

export function hasDraftVerb(question: string): boolean {
  return DRAFT_VERB_RE.test(question);
}

export function hasUnverifiedPremise(question: string): boolean {
  return PREMISE_RE.test(question);
}

/**
 * Generic nouns that name a deliverable. Used to detect deliverables this
 * agent does NOT recognise.
 *
 * Without this, the classifier can only count deliverables it has a rubric
 * for - so "generate a DFMEA and an Export Control Document" looks like a
 * SINGLE-deliverable request, and the export control document is silently
 * dropped. A classifier that undercounts is worse than one that refuses.
 */
const DELIVERABLE_NOUN_RE =
  /\b(document|report|analysis|assessment|plan|register|procedure|specification|spec|protocol|dossier|statement|memo|record|summary|review)\b/gi;

export interface DeliverableCount {
  /** Document types this agent recognises and can evaluate. */
  recognised: AliasMatch[];
  /** How many deliverable-shaped phrases remain after removing the recognised ones. */
  unrecognised: number;
  /** The unrecognised noun phrases, for the clarification message. */
  unrecognisedNouns: string[];
}

/**
 * Count every deliverable named, recognised or not.
 *
 * Recognised aliases are removed from the text before counting generic nouns,
 * so "design failure mode and effects analysis" is one deliverable, not two
 * (the alias plus a stray "analysis").
 */
export function countDeliverables(question: string): DeliverableCount {
  const recognised = findDocumentTypes(question);

  let residue = normalise(question);
  for (const m of recognised) {
    residue = residue.split(m.matchedAlias).join(" ");
  }

  const matches = residue.match(DELIVERABLE_NOUN_RE) ?? [];
  const unrecognisedNouns = [...new Set(matches.map((m) => m.toLowerCase()))];

  return {
    recognised,
    unrecognised: unrecognisedNouns.length,
    unrecognisedNouns,
  };
}