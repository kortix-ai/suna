//! Deterministic, offline OCR text masking. A future local NER detector can
//! contribute spans here without changing the recorder's write boundary.
use regex::Regex;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    pub replacement: &'static str,
}

fn patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (r"(?i)\b(?:AKIA|ASIA)[A-Z0-9]{16}\b", "[secret]"),
            (r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b", "[secret]"),
            (r"\b(?:xox[baprs]-[A-Za-z0-9-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b", "[secret]"),
            (r#"(?i)\b(?:api[_ -]?key|access[_ -]?token|secret[_ -]?key|bearer)\b["']?\s*[:=]?\s*["']?[A-Za-z0-9_./+=-]{16,}\b"#, "[secret]"),
            (r"(?i)\b[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}\b", "[email]"),
            // An address whose domain end is missing (OCR cut the line at "example.").
            (r"(?i)\b[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}](?:[\p{L}\p{N}.@-]*[\p{L}\p{N}])?\.?", "[email]"),
            (r"\b[0-9]{3}[- .][0-9]{2}[- .][0-9]{4}\b", "[ssn]"),
            (r"(?i)\b(?:ssn|social[ -]security(?:[ -]number)?)\b[ \t:=#-]*[0-9](?:[ .-]?[0-9]){8}\b", "[ssn]"),
            (r"(?:\b|\\[nt])(?:[0-9][ -]?){12,18}[0-9]\b", "[card]"),
            // A card number being typed: three full groups and up to three more digits.
            (r"\b[2-6][0-9]{3}[ -][0-9]{4}[ -][0-9]{4}(?:[ -][0-9]{1,3})?\b", "[card]"),
            (r"(?i)\b[A-Z]{2}[0-9]{2}(?:[ ]?[A-Z0-9]){11,30}\b", "[iban]"),
            (r"(?i)(?:\+?1[ .-]?)?(?:\([0-9]{3}\)|[0-9]{3})[ .-]?[0-9]{3}[ .-]?[0-9]{4}(?:[ \t]*(?:x|ext\.?|#)[ \t]*[0-9]{1,6})?\b", "[phone]"),
            (r"(?i)\+[1-9][0-9]{0,3}(?:[ .-]?\(?[0-9]{1,4}\)?){2,6}(?:[ \t]*(?:x|ext\.?|#)[ \t]*[0-9]{1,6})?\b", "[phone]"),
            // The same number URL-encoded in an address bar or link: `?q=%2B1+555+0100+0100`.
            (r"(?i)(?:\+|%2B)[1-9][0-9]{0,3}(?:(?:\+|%20)[0-9]{1,4}){2,6}\b", "[phone]"),
            (r"(?i)\(?0[0-9]{2,4}\)?[ .-][0-9]{3,4}[ .-]?[0-9]{3,4}(?:[ \t]*(?:x|ext\.?|#)[ \t]*[0-9]{1,6})?\b", "[phone]"),
            (r"(?i)\b(?:phone(?: number)?|tel(?:ephone)?|mobile)\b[ \t]*[:|=-]?[ \t]*\+?\(?[0-9][0-9(). -]{5,22}[0-9](?:[ \t]*(?:x|ext\.?|#)[ \t]*[0-9]{1,6})?\b", "[phone]"),
        ]
        .into_iter()
        .map(|(pattern, label)| (Regex::new(pattern).expect("valid redaction regex"), label))
        .collect()
    })
}

fn luhn(value: &str) -> bool {
    let digits: Vec<u32> = value.chars().filter_map(|c| c.to_digit(10)).collect();
    (13..=19).contains(&digits.len())
        && digits.iter().any(|d| *d != 0)
        && digits
            .iter()
            .rev()
            .enumerate()
            .map(|(i, d)| {
                if i % 2 == 1 {
                    let n = d * 2;
                    n / 10 + n % 10
                } else {
                    *d
                }
            })
            .sum::<u32>()
            % 10
            == 0
}

/// A card number captured while it is typed (screen memory takes a frame every
/// 2 s, so every prefix reaches the OCR): `4111 1111 1111` or `4111 1111 1111 11`.
/// A complete 16-digit number must pass Luhn instead.
fn partial_card(value: &str) -> bool {
    static SHAPE: OnceLock<Regex> = OnceLock::new();
    SHAPE
        .get_or_init(|| {
            Regex::new(r"^[2-6][0-9]{3}([ -])[0-9]{4}([ -])[0-9]{4}(?:[ -][0-9]{1,3})?$")
                .expect("valid card prefix regex")
        })
        .is_match(value)
}

fn iban(value: &str) -> bool {
    let compact: Vec<u8> = value
        .bytes()
        .filter(|b| *b != b' ')
        .map(|b| b.to_ascii_uppercase())
        .collect();
    if !(15..=34).contains(&compact.len()) {
        return false;
    }
    let mut remainder = 0u32;
    for b in compact[4..].iter().chain(compact[..4].iter()) {
        if b.is_ascii_digit() {
            remainder = (remainder * 10 + u32::from(b - b'0')) % 97;
        } else if b.is_ascii_uppercase() {
            remainder = (remainder * 100 + u32::from(b - b'A' + 10)) % 97;
        } else {
            return false;
        }
    }
    remainder == 1
}

fn spans(text: &str) -> Vec<Span> {
    let mut candidates = Vec::new();
    for (pattern, replacement) in patterns() {
        for m in pattern.find_iter(text) {
            let mut end = m.end();
            let valid = match *replacement {
                "[card]" => {
                    let stop = candidates
                        .iter()
                        .filter(|s: &&Span| s.start > m.start() && s.start < m.end())
                        .map(|s| s.start)
                        .min()
                        .unwrap_or(m.end());
                    let candidate = text[m.start()..stop].trim_end_matches([' ', '-']);
                    end = m.start() + candidate.len();
                    // A prefix only counts when no digit group follows it (else it is
                    // the start of a longer, Luhn-checked number).
                    let more = text[end..]
                        .strip_prefix([' ', '-'])
                        .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()));
                    luhn(candidate) || (partial_card(candidate) && !more)
                }
                "[iban]" => {
                    // The regex may include following prose. Keep the longest
                    // checksum-valid prefix ending on a real token boundary.
                    let prefix = (0..=m.as_str().len()).rev().find(|n| {
                        (*n == m.as_str().len() || m.as_str().as_bytes()[*n] == b' ')
                            && iban(m.as_str()[..*n].trim_end())
                    });
                    if let Some(n) = prefix {
                        end = m.start() + m.as_str()[..n].trim_end().len();
                    }
                    prefix.is_some()
                }
                "[phone]" => {
                    let lower = m.as_str().to_ascii_lowercase();
                    let extension = [lower.find('x'), lower.find("ext"), lower.find('#')]
                        .into_iter()
                        .flatten()
                        .min()
                        .unwrap_or(lower.len());
                    let core = &lower[..extension];
                    let digits = core.bytes().filter(|b| b.is_ascii_digit()).count();
                    let labelled = core.starts_with("phone")
                        || core.starts_with("tel")
                        || core.starts_with("mobile");
                    let minimum = if labelled {
                        7
                    } else if core.starts_with('+') {
                        8
                    } else {
                        10
                    };
                    (minimum..=15).contains(&digits)
                        && core.bytes().any(|c| (b'1'..=b'9').contains(&c))
                        && text[..m.start()]
                            .chars()
                            .next_back()
                            .is_none_or(|c| !c.is_alphanumeric())
                        && text[m.end()..]
                            .chars()
                            .next()
                            .is_none_or(|c| !c.is_alphanumeric())
                }
                "[ssn]" => {
                    let s: Vec<u8> = m.as_str().bytes().filter(|c| c.is_ascii_digit()).collect();
                    s.len() == 9
                        && &s[..3] != b"000"
                        && &s[..3] != b"666"
                        && s[0] != b'9'
                        && &s[3..5] != b"00"
                        && &s[5..] != b"0000"
                }
                _ => true,
            };
            if valid {
                candidates.push(Span {
                    start: m.start(),
                    end,
                    replacement,
                });
            }
        }
    }
    candidates.sort_by_key(|s| (s.start, std::cmp::Reverse(s.end)));
    let mut selected = Vec::new();
    for s in candidates {
        if selected
            .last()
            .is_none_or(|last: &Span| s.start >= last.end)
        {
            selected.push(s);
        }
    }
    selected
}

pub struct Redacted {
    pub text: String,
    pub starts: Vec<usize>,
    pub ends: Vec<usize>,
    pub ranges: Vec<(usize, usize)>,
}

/// Mask text and return maps from old character boundaries to new start/end
/// boundaries, preserving box offsets after placeholders change text length.
pub fn redact(text: &str) -> Redacted {
    redact_with_spans(text, &[])
}

/// Model spans use UTF-8 byte offsets. Union overlapping detections so a
/// partial pattern can never discard a larger model detection (or vice versa).
pub fn redact_with_spans(text: &str, additional: &[Span]) -> Redacted {
    let mut found = spans(text);
    found.extend(additional.iter().copied().filter(|s| {
        s.start < s.end
            && s.end <= text.len()
            && text.is_char_boundary(s.start)
            && text.is_char_boundary(s.end)
    }));
    found.sort_by_key(|s| (s.start, std::cmp::Reverse(s.end)));
    let mut merged: Vec<Span> = Vec::new();
    for span in found {
        if let Some(last) = merged.last_mut().filter(|last| span.start < last.end) {
            last.end = last.end.max(span.end);
        } else {
            merged.push(span);
        }
    }
    let found = merged;
    let count = text.chars().count();
    let mut starts = vec![0; count + 1];
    let mut ends = vec![0; count + 1];
    let mut output = String::with_capacity(text.len());
    let mut old_char = 0;
    let mut new_char = 0;
    let mut cursor = 0;
    let mut ranges = Vec::with_capacity(found.len());
    for span in &found {
        let plain = &text[cursor..span.start];
        output.push_str(plain);
        for i in 0..plain.chars().count() {
            starts[old_char + i] = new_char + i;
            ends[old_char + i] = new_char + i;
        }
        old_char += plain.chars().count();
        new_char += plain.chars().count();
        let width = text[span.start..span.end].chars().count();
        let replacement_width = span.replacement.chars().count();
        ranges.push((old_char, old_char + width));
        ends[old_char] = new_char;
        for i in 0..width {
            starts[old_char + i] = new_char;
            ends[old_char + i + 1] = new_char + replacement_width;
        }
        output.push_str(span.replacement);
        old_char += width;
        new_char += replacement_width;
        starts[old_char] = new_char;
        cursor = span.end;
    }
    let tail = &text[cursor..];
    output.push_str(tail);
    for i in 0..=tail.chars().count() {
        starts[old_char + i] = new_char + i;
        ends[old_char + i] = new_char + i;
    }
    Redacted {
        text: output,
        starts,
        ends,
        ranges,
    }
}

pub fn redact_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => {
            let found = spans(s);
            if !found.is_empty() {
                let mut output = String::with_capacity(s.len());
                let mut cursor = 0;
                for span in found {
                    output.push_str(&s[cursor..span.start]);
                    output.push_str(span.replacement);
                    cursor = span.end;
                }
                output.push_str(&s[cursor..]);
                *s = output;
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(redact_value),
        serde_json::Value::Object(fields) => {
            // AX values can be separate from their visible credential label.
            // A token masked in OCR must not survive in that metadata.
            let credential_value = fields.get("role").and_then(|v| v.as_str())
                == Some("AXSecureTextField")
                || ["label", "description", "title"].iter().any(|key| {
                    fields
                        .get(*key)
                        .and_then(|v| v.as_str())
                        .is_some_and(secret_field)
                });
            for (key, value) in fields {
                if (secret_field(key) || (credential_value && key == "value"))
                    && value.as_str().is_some_and(|s| !s.is_empty())
                {
                    *value = serde_json::json!("[secret]");
                } else {
                    redact_value(value);
                }
            }
        }
        _ => {}
    }
}

fn secret_field(label: &str) -> bool {
    let normalized: String = label
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-' | ':'))
        .flat_map(char::to_lowercase)
        .collect();
    matches!(
        normalized.as_str(),
        "apikey"
            | "accesstoken"
            | "secretkey"
            | "password"
            | "passwd"
            | "authorization"
            | "bearertoken"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn masks_patterns_and_rejects_invalid_checksums() {
        for (input, placeholder) in [
            ("alice@example.com", "[email]"),
            ("4111 1111 1111 1111", "[card]"),
            ("123-45-6789", "[ssn]"),
            ("+1 555 010 0100", "[phone]"),
            ("GB82 WEST 1234 5698 7654 32", "[iban]"),
            ("AKIAIOSFODNN7EXAMPLE", "[secret]"),
            ("ghp_abcdefghijklmnopqrstuvwxyz", "[secret]"),
        ] {
            assert_eq!(redact(input).text, placeholder, "{input}");
        }
        assert_eq!(redact("4111 1111 1111 1112").text, "4111 1111 1111 1112");
        assert_eq!(
            redact("4111 1111 1111 1111 123-45-6789").text,
            "[card] [ssn]"
        );
    }

    #[test]
    fn a_phone_number_url_encoded_in_an_address_bar_is_masked() {
        // Found by the real-OS privacy scenario: Firefox showed the search URL
        // "…/search.html?q=saffron+%2B1+555+0192+4937" and the number stayed searchable.
        for url in [
            "http://127.0.0.1:8765/pages/search.html?q=saffron+%2B1+555+0192+4937",
            "search.html?q=saffron++1+555+0192+4937",
            "?q=%2b44%207946%200958",
        ] {
            let out = redact(url).text;
            assert!(
                out.contains("[phone]") && !out.contains("0192") && !out.contains("7946"),
                "{url} -> {out}"
            );
        }
        for benign in ["a+1+2+3", "x+1234+5678", "?page=2+3"] {
            assert_eq!(redact(benign).text, benign);
        }
    }

    #[test]
    fn a_card_number_captured_while_typed_is_masked() {
        // Found by the real-OS privacy scenario: frames taken while
        // "4111 1111 1111 1111" was typed held "4111 1111 1111" and stayed searchable.
        for typing in [
            "4111 1111 1111",
            "4111 1111 1111 1",
            "4111-1111-1111-11",
            "Card on file 5500 0000 0000 00",
        ] {
            let out = redact(typing).text;
            assert!(
                out.contains("[card]") && !out.contains("1111 1111") && !out.contains("0000 0000"),
                "{typing} -> {out}"
            );
        }
        // Complete numbers still need Luhn; zeros, short groups and other shapes stay.
        for benign in [
            "4111 1111 1111 1112",
            "0000 0000 0000",
            "1234 5678 9012",
            "4111 1111",
            "order 2048 2049",
        ] {
            assert_eq!(redact(benign).text, benign);
        }
    }

    #[test]
    fn an_address_whose_domain_end_ocr_cut_off_is_still_an_email() {
        // Found by the real-OS privacy scenario: a terminal line wrapped after
        // "example." and OCR read "qzorbit59.wexley@example." with the TLD elsewhere,
        // so the address stayed searchable with privacy.redact_pii on.
        for input in [
            "qzorbit59.wexley@example.",
            "qzorbit59.wexley@example",
            "$ echo qzorbit59.wexley@exam",
        ] {
            let out = redact(input).text;
            assert!(!out.contains("qzorbit59"), "{input} -> {out}");
            assert!(out.contains("[email]"), "{input} -> {out}");
        }
        // Two at-signs (a pasted alias in front of an address) mask as one address.
        assert_eq!(
            redact("x aahana63@johnpoole@example.org y").text,
            "x [email] y"
        );
        // No local part, no address: handles and plain at-signs stay.
        for benign in ["@channel", "meet @ 5pm", "a @ b"] {
            assert_eq!(redact(benign).text, benign);
        }
    }

    #[test]
    fn unicode_multiple_matches_and_boundary_maps_are_consistent() {
        let input = "Résumé: alice@example.com; 4111 1111 1111 1111; fin.";
        let result = redact(input);
        assert_eq!(result.text, "Résumé: [email]; [card]; fin.");
        assert_eq!(result.starts.len(), input.chars().count() + 1);
        assert_eq!(result.ends.len(), result.starts.len());
        assert!(result.starts.windows(2).all(|w| w[0] <= w[1]));
        assert!(result.ends.windows(2).all(|w| w[0] <= w[1]));
        assert_eq!(
            result.starts.last().copied(),
            Some(result.text.chars().count())
        );
        assert_eq!(redact(&result.text).text, result.text);
    }

    #[test]
    fn grouped_iban_does_not_swallow_following_prose() {
        assert_eq!(
            redact("GB82 WEST 1234 5698 7654 32 PAID invoice").text,
            "[iban] PAID invoice"
        );
        assert_eq!(redact("gb82west12345698765432").text, "[iban]");
        assert_eq!(
            redact("GB82 WEST 1234 5698 7654 33").text,
            "GB82 WEST 1234 5698 7654 33"
        );
    }

    #[test]
    fn phone_boundaries_and_additional_secret_shapes() {
        for phone in ["+1 555 0100", "+44 20 7946 0958", "(555) 010-0100"] {
            assert_eq!(redact(phone).text, "[phone]");
        }
        for benign in [
            "SKU15550100100",
            "12345678901234567890",
            "0000 0000 0000 0000",
            "order 2048",
        ] {
            assert_eq!(redact(benign).text, benign);
        }
        // Split so no literal token shape sits in the source (secret scanners).
        for token in [
            format!("{}{}", "sk_te", "st_abcdefghijklmnopqrstuvwxyz"),
            format!("{}{}", "xo", "xb-1234567890-abcdefghijklmnop"),
            "Bearer abcdefghijklmnopqrstuvwxyz".to_string(),
        ] {
            assert_eq!(redact(&token).text, "[secret]");
        }
        assert_eq!(redact("o'connor@example.com").text, "[email]");
    }

    #[test]
    fn independent_dataset_format_regressions() {
        for phone in [
            "+1-555-010-0100x2048",
            "1 (555) 010-0100",
            "+44(0)131 4960267",
            "(0151) 496 0597",
            "Phone: 8075.3162",
            "555.010.0100 ext. 42",
        ] {
            assert_eq!(redact(phone).text, "[phone]", "{phone}");
        }
        for ssn in [
            "123 45 6789",
            "123.45.6789",
            "SSN: 123456789",
            "Social Security Number 123 456 789",
        ] {
            assert_eq!(redact(ssn).text, "[ssn]");
        }
        assert_eq!(
            redact(r"Each\n4111111111111111\tNut").text,
            r"Each[card]\tNut"
        );
        assert_eq!(
            redact(r#"{"api_key":"abcdefghijklmnopqrstuvwxyz"}"#).text,
            r#"{"[secret]"}"#
        );
    }

    #[test]
    fn credential_values_cannot_escape_through_separate_ax_labels() {
        let mut metadata = serde_json::json!({"api_key": "synthetic_unprefixed_token", "nodes": [
            {"role": "AXTextField", "description": "API key", "value": "synthetic_unprefixed_token"},
            {"role": "AXSecureTextField", "value": "synthetic_password"},
            {"role": "AXTextField", "description": "Order status", "value": "pending"}
        ]});
        redact_value(&mut metadata);
        assert!(!metadata.to_string().contains("synthetic_unprefixed_token"));
        assert!(!metadata.to_string().contains("synthetic_password"));
        assert_eq!(metadata["nodes"][2]["value"], "pending");
    }

    proptest::proptest! {
        #[test]
        fn any_unicode_input_has_valid_monotone_maps(input in ".{0,300}") {
            let result = redact(&input);
            let length = result.text.chars().count();
            proptest::prop_assert!(result.starts.iter().chain(&result.ends).all(|n| *n <= length));
            proptest::prop_assert!(result.starts.windows(2).all(|w| w[0] <= w[1]));
            proptest::prop_assert!(result.ends.windows(2).all(|w| w[0] <= w[1]));
            proptest::prop_assert_eq!(redact(&result.text).text, result.text);
        }
    }
}
