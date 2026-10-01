//! Sparse TF-IDF embeddings and cosine distance for `query cover`.

use std::collections::HashMap;

fn tokens(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric()).filter(|t| t.chars().count() >= 2).map(str::to_lowercase)
}

/// Unit-length TF-IDF vectors (sorted `(term id, weight)`), one per document.
pub fn embed(docs: &[&str]) -> Vec<Vec<(u32, f32)>> {
    let mut vocab: HashMap<String, u32> = HashMap::new();
    let mut counts: Vec<HashMap<u32, f32>> = Vec::with_capacity(docs.len());
    let mut df: Vec<u32> = Vec::new();
    for d in docs {
        let mut tf: HashMap<u32, f32> = HashMap::new();
        for t in tokens(d) {
            let next = vocab.len() as u32;
            let id = *vocab.entry(t).or_insert(next);
            if id as usize == df.len() {
                df.push(0);
            }
            *tf.entry(id).or_default() += 1.0;
        }
        for id in tf.keys() {
            df[*id as usize] += 1;
        }
        counts.push(tf);
    }
    let n = docs.len() as f32;
    counts
        .into_iter()
        .map(|tf| {
            let mut v: Vec<(u32, f32)> =
                tf.into_iter().map(|(id, c)| (id, (1.0 + c.ln()) * (((n + 1.0) / (df[id as usize] as f32 + 1.0)).ln() + 1.0))).collect();
            let norm = v.iter().map(|(_, w)| w * w).sum::<f32>().sqrt();
            if norm > 0.0 {
                v.iter_mut().for_each(|(_, w)| *w /= norm);
            }
            v.sort_by_key(|(id, _)| *id);
            v
        })
        .collect()
}

/// `1 - cosine`; two empty documents are identical, an empty and a non-empty one are unrelated.
pub fn distance(a: &[(u32, f32)], b: &[(u32, f32)]) -> f32 {
    if a.is_empty() || b.is_empty() {
        return if a.is_empty() && b.is_empty() { 0.0 } else { 1.0 };
    }
    let (mut i, mut j, mut dot) = (0, 0, 0.0f32);
    while i < a.len() && j < b.len() {
        match a[i].0.cmp(&b[j].0) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                dot += a[i].1 * b[j].1;
                i += 1;
                j += 1;
            }
        }
    }
    (1.0 - dot).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_text_has_zero_distance_and_disjoint_text_one() {
        let v = embed(&["alpha beta gamma", "alpha beta gamma", "delta epsilon zeta", ""]);
        assert!(distance(&v[0], &v[1]) < 1e-5);
        assert!((distance(&v[0], &v[2]) - 1.0).abs() < 1e-5);
        assert_eq!(distance(&v[3], &v[3]), 0.0);
        assert_eq!(distance(&v[0], &v[3]), 1.0);
    }

    #[test]
    fn partial_overlap_is_between() {
        let v = embed(&["one two three four", "one two five six", "zzz yyy"]);
        let d = distance(&v[0], &v[1]);
        assert!(d > 0.1 && d < 0.95, "{d}");
    }
}
