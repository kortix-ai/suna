// Review column presets. Plain data with no Convex imports: the browser imports it too.

export type Column = {
  key: string;
  label: string;
  prompt: string;
  format: "text" | "yes_no" | "date" | "money" | "tag" | "verbatim" | "number" | "percent" | "list";
  options?: string[];
};

/** The "Commercial contract basics" preset. Keys are stable: the eval answer key uses them. */
export const PRESET_COLUMNS: Column[] = [
  { key: "parties", label: "Parties", prompt: "Who are the parties to the agreement, and what role does each have?", format: "text" },
  { key: "term", label: "Term", prompt: "How long does the agreement, or its main obligation, last?", format: "text" },
  { key: "auto_renewal", label: "Auto-renewal", prompt: "Does the agreement renew automatically?", format: "yes_no" },
  {
    key: "termination_convenience", label: "Termination for convenience",
    prompt: "Can a party terminate without cause (for convenience, for any reason, or under a break clause)? A right that arises only on an event (breach, insolvency, a long-stop date, a condition not met, force majeure, change of control) is not termination for convenience.", format: "yes_no",
  },
  { key: "liability_cap", label: "Liability cap", prompt: "Is liability capped, and at what amount?", format: "text" },
  { key: "governing_law", label: "Governing law", prompt: "Which law governs the agreement?", format: "text" },
  { key: "assignment", label: "Assignment", prompt: "Can a party assign the agreement, and on what condition?", format: "text" },
  {
    key: "change_of_control", label: "Change of control",
    prompt: "Does the agreement contain a change-of-control provision: a consent requirement, condition or termination right triggered by a change of control of a party or of the target?",
    format: "yes_no",
  },
];

/** The due-diligence checklist: the map batches fill it per document; the reduce batch writes the report from it. */
export const DD_COLUMNS: Column[] = [
  {
    key: "doc_type", label: "Type", prompt: "Which kind of document is this?", format: "tag",
    options: ["MSA", "SaaS", "Lease", "Employment", "SPA", "Supply", "DPA", "NDA", "Consulting", "Other"],
  },
  {
    key: "key_terms", label: "Key terms",
    prompt: "The 3 to 5 terms a buyer's counsel must know, from the due-diligence checklist for this document type (≤ 40 words).", format: "text",
  },
  { key: "liability", label: "Liability", prompt: "Is liability capped, and at what amount? Say \"Uncapped\" when no cap applies.", format: "text" },
  {
    key: "change_of_control", label: "Change of control",
    prompt: "Does a change of control of a party or of the target need consent, or give a termination right?", format: "yes_no",
  },
  {
    key: "exclusivity", label: "Exclusivity",
    prompt: "Any exclusivity, non-compete or most-favoured-customer term binding a party, with its duration.", format: "text",
  },
  { key: "assignment", label: "Assignment", prompt: "Can a party assign the agreement, and on what condition?", format: "text" },
  { key: "ip_ownership", label: "IP ownership", prompt: "Who owns the intellectual property in work product or deliverables?", format: "text" },
  {
    key: "red_flags", label: "Red flags",
    prompt: "Which red flags from the due-diligence rubric does this document raise? Name each one, or say \"None\".", format: "text",
  },
];

/**
 * The clause library: common review columns a lawyer picks by name. Keys are
 * suggestions; the builder makes them unique within a review.
 */
export const COLUMN_LIBRARY: Column[] = [
  PRESET_COLUMNS[0],
  { key: "effective_date", label: "Effective date", prompt: "On what date does the agreement take effect?", format: "date" },
  PRESET_COLUMNS[1],
  PRESET_COLUMNS[2],
  { key: "notice_period", label: "Notice period", prompt: "What notice must a party give to terminate or not renew, and how is it served?", format: "text" },
  PRESET_COLUMNS[3],
  { key: "termination_events", label: "Termination events", prompt: "On which events can a party terminate (breach, insolvency, change of control, other)? List each.", format: "list" },
  PRESET_COLUMNS[4],
  { key: "liability_cap_amount", label: "Liability cap amount", prompt: "What is the amount of the general liability cap? Give the amount and currency.", format: "money" },
  { key: "indemnities", label: "Indemnities", prompt: "Which indemnities does each party give, and are they capped?", format: "list" },
  { key: "warranties", label: "Warranties", prompt: "What warranties does each party give?", format: "list" },
  PRESET_COLUMNS[5],
  { key: "jurisdiction", label: "Jurisdiction", prompt: "Which courts or arbitration forum resolve disputes?", format: "text" },
  PRESET_COLUMNS[6],
  PRESET_COLUMNS[7],
  { key: "confidentiality", label: "Confidentiality", prompt: "What confidentiality obligations apply, and for how long do they survive?", format: "text" },
  { key: "payment_terms", label: "Payment terms", prompt: "When and how is payment due, and what happens on late payment?", format: "text" },
  { key: "price_increase", label: "Price increase", prompt: "By what percentage can the price or rent rise each year? Give the number only.", format: "percent" },
  { key: "exclusivity", label: "Exclusivity", prompt: "Any exclusivity, non-compete or most-favoured-customer term binding a party, with its duration.", format: "text" },
  { key: "non_solicit_months", label: "Non-solicit (months)", prompt: "For how many months does a non-solicitation covenant last? Give the number only.", format: "number" },
  { key: "force_majeure", label: "Force majeure", prompt: "Is there a force majeure clause, and what does it excuse?", format: "text" },
  { key: "data_protection", label: "Data protection", prompt: "Which data protection obligations apply, and who is controller or processor?", format: "text" },
  { key: "amendment", label: "Amendment", prompt: "How can the agreement be amended?", format: "text" },
];

const FORMAT_ASK: Record<Column["format"], string> = {
  text: "Answer in at most 40 words, the answer first.",
  yes_no: "Answer yes or no.",
  date: "Give the date (YYYY-MM-DD) or the duration.",
  money: "Give the amount and the currency.",
  tag: "Answer with one of the options.",
  verbatim: "Quote the clause exactly.",
  number: "Give the number only.",
  percent: "Give the percentage as a number only.",
  list: "List each item separately.",
};

/** A column's question written from its label and format: "Write it for me" in the column builder. */
export function promptFor(label: string, format: Column["format"]): string {
  const known = COLUMN_LIBRARY.find((c) => c.label.toLowerCase() === label.trim().toLowerCase());
  if (known && known.format === format) return known.prompt;
  const subject = label.trim().replace(/[?.]+$/, "") || "this term";
  return `What does the agreement provide on ${subject.toLowerCase()}? ${FORMAT_ASK[format]} If the agreement is silent, say so.`;
}
