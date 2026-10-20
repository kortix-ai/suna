// Review column presets. Plain data with no Convex imports: the browser imports it too.

export type Column = {
  key: string;
  label: string;
  prompt: string;
  format: "text" | "yes_no" | "date" | "money" | "tag" | "verbatim";
  options?: string[];
};

/** The "Commercial contract basics" preset. Keys are stable: the eval answer key uses them. */
export const PRESET_COLUMNS: Column[] = [
  { key: "parties", label: "Parties", prompt: "Who are the parties to the agreement, and what role does each have?", format: "text" },
  { key: "term", label: "Term", prompt: "How long does the agreement, or its main obligation, last?", format: "text" },
  { key: "auto_renewal", label: "Auto-renewal", prompt: "Does the agreement renew automatically?", format: "yes_no" },
  {
    key: "termination_convenience", label: "Termination for convenience",
    prompt: "Can a party terminate without cause (for convenience, for any reason, or under a break clause)?", format: "yes_no",
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
