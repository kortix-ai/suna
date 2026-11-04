/** Secret-shaped values: bearer tokens, provider keys, Kortix tokens, `token=`/`password=` pairs. A leaf, so pure modules import it. */
export const SECRET_VALUE_RE =
  /(?:bearer\s+[a-z0-9._~+/=-]+|sk-[a-z0-9_-]{12,}|gh[opusr]_[a-z0-9_]{12,}|kortix_(?:pat|sbx)_[a-z0-9_-]+|(?:token|secret|password|api[_-]?key)=\S+)/i;
