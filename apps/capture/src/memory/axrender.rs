//! Render a captured accessibility tree (JSON from the capture engine) as XML
//! or indented text, with simplification switches for agents.

use serde_json::Value;

#[derive(Debug, Clone, Default)]
pub struct AxOpts {
    pub raw: bool,
    pub human: bool,
    pub include_hidden: bool,
    pub coords: bool,
    pub no_collapse: bool,
    pub text_only: bool,
    pub max_depth: Option<usize>,
    pub roles: Vec<String>,
}

pub struct AxMeta {
    pub frame_id: i64,
    pub timestamp: String,
    pub application: String,
    pub title: String,
    pub bundle: String,
    pub pid: i64,
    pub captured_utc: String,
    pub node_count: i64,
    pub stored_bytes: usize,
    pub partial: bool,
}

const WRAPPERS: [&str; 5] = ["AXGroup", "AXGenericElement", "AXLayoutItem", "AXLayoutArea", "AXUnknown"];

#[derive(Debug)]
struct Node {
    role: String,
    attrs: Vec<(&'static str, String)>,
    children: Vec<Node>,
}

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|x| !x.is_empty())
}

fn has_text(v: &Value) -> bool {
    ["title", "description", "value"].iter().any(|k| s(v, k).is_some())
}

fn count(v: &Value, pred: &dyn Fn(&Value) -> bool) -> usize {
    let kids = v.get("children").and_then(Value::as_array).map(|c| c.iter().map(|k| count(k, pred)).sum()).unwrap_or(0);
    kids + pred(v) as usize
}

fn depth(v: &Value) -> usize {
    1 + v.get("children").and_then(Value::as_array).map(|c| c.iter().map(depth).max().unwrap_or(0)).unwrap_or(0)
}

fn build(v: &Value, o: &AxOpts, root: bool) -> Vec<Node> {
    if !o.include_hidden && v.get("hidden").and_then(Value::as_bool) == Some(true) {
        return Vec::new();
    }
    let role = s(v, "role").unwrap_or("AXUnknown");
    let kids: Vec<Node> = v
        .get("children")
        .and_then(Value::as_array)
        .map(|c| c.iter().flat_map(|k| build(k, o, false)).collect())
        .unwrap_or_default();
    let text = has_text(v);
    let drop_self = !root
        && ((o.text_only && !text)
            || (!o.roles.is_empty() && !o.roles.iter().any(|r| r == role))
            || (!o.no_collapse && WRAPPERS.contains(&role) && !text));
    if drop_self {
        return kids;
    }
    let mut attrs = Vec::new();
    for (key, name) in [
        ("subrole", "subrole"),
        ("role_description", "roleDescription"),
        ("title", "title"),
        ("description", "desc"),
        ("value", "value"),
        ("url", "url"),
        ("dom_id", "domId"),
        ("dom_class", "domClass"),
    ] {
        if let Some(x) = s(v, key) {
            attrs.push((name, x.to_string()));
        }
    }
    if o.coords {
        let n = |k: &str| v.get(k).and_then(Value::as_i64);
        if let (Some(x), Some(y), Some(w), Some(h)) = (n("x"), n("y"), n("w"), n("h")) {
            for (k, val) in [("x", x), ("y", y), ("w", w), ("h", h)] {
                attrs.push((k, val.to_string()));
            }
        }
    }
    if v.get("visited").and_then(Value::as_bool) == Some(true) {
        attrs.push(("visited", "true".into()));
    }
    if v.get("hidden").and_then(Value::as_bool) == Some(true) {
        attrs.push(("hidden", "true".into()));
    }
    if v.get("disabled").and_then(Value::as_bool) == Some(true) {
        attrs.push(("disabled", "true".into()));
    }
    if v.get("truncated").and_then(Value::as_bool) == Some(true) {
        attrs.push(("truncated", "true".into()));
    }
    vec![Node { role: role.to_string(), attrs, children: kids }]
}

fn size(n: &Node) -> usize {
    1 + n.children.iter().map(size).sum::<usize>()
}

/// Cap depth: nodes at `max` lose their children and report how many were cut.
fn cut(n: &mut Node, level: usize, max: usize) {
    if level >= max {
        let hidden: usize = n.children.iter().map(size).sum();
        if hidden > 0 {
            n.attrs.retain(|(k, _)| *k != "truncated");
            n.attrs.push(("truncated", format!("{hidden} nodes")));
        }
        n.children.clear();
    } else {
        for c in &mut n.children {
            cut(c, level + 1, max);
        }
    }
}

fn esc(x: &str) -> String {
    x.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

fn xml(n: &Node, ind: usize, out: &mut String) {
    let pad = "  ".repeat(ind);
    let attrs: String = n.attrs.iter().map(|(k, v)| format!(" {k}=\"{}\"", esc(v))).collect();
    if n.children.is_empty() {
        out.push_str(&format!("{pad}<{}{attrs}/>\n", n.role));
    } else {
        out.push_str(&format!("{pad}<{}{attrs}>\n", n.role));
        for c in &n.children {
            xml(c, ind + 1, out);
        }
        out.push_str(&format!("{pad}</{}>\n", n.role));
    }
}

fn human(n: &Node, ind: usize, out: &mut String) {
    let mut line = format!("{}[{}]", "  ".repeat(ind), n.role);
    let mut pos = None;
    let mut dims: [Option<String>; 4] = Default::default();
    for (k, v) in &n.attrs {
        match *k {
            "title" => line.push_str(&format!(" \"{v}\"")),
            "x" => dims[0] = Some(v.clone()),
            "y" => dims[1] = Some(v.clone()),
            "w" => dims[2] = Some(v.clone()),
            "h" => dims[3] = Some(v.clone()),
            _ => line.push_str(&format!(" {k}=\"{v}\"")),
        }
    }
    if let [Some(x), Some(y), Some(w), Some(h)] = dims {
        pos = Some(format!(" @({x},{y}) {w}x{h}"));
    }
    line.push_str(&pos.unwrap_or_default());
    out.push_str(&line);
    out.push('\n');
    for c in &n.children {
        human(c, ind + 1, out);
    }
}

pub fn render(tree: &Value, meta: &AxMeta, o: &AxOpts) -> String {
    let mut o = o.clone();
    if o.raw {
        o = AxOpts { raw: true, human: o.human, include_hidden: true, coords: true, no_collapse: true, ..Default::default() };
    }
    let wrapped = serde_json::json!({"role": "AXApplication", "title": meta.application, "children": [tree]});
    let mut root = build(&wrapped, &o, true).into_iter().next().expect("root is never dropped");
    if let Some(max) = o.max_depth {
        cut(&mut root, 0, max);
    }
    let text_nodes = count(tree, &has_text);
    let mut filters = Vec::new();
    if o.include_hidden && !o.raw {
        filters.push("hidden=on".to_string());
    }
    if o.coords && !o.raw {
        filters.push("coords=on".into());
    }
    if o.no_collapse && !o.raw {
        filters.push("collapse=off".into());
    }
    if o.text_only {
        filters.push("text_only=on".into());
    }
    if let Some(m) = o.max_depth {
        filters.push(format!("max_depth={m}"));
    }
    if !o.roles.is_empty() {
        filters.push(format!("roles={}", o.roles.join(",")));
    }
    if o.raw {
        filters.push("raw=on".into());
    }
    let filters = filters.join(" ");
    let summary = format!("nodes={} stored_bytes={} partial={}", meta.node_count, meta.stored_bytes, meta.partial);
    let mut out = String::new();
    if o.human {
        out.push_str(&format!("Frame {} | {} | {} | {}\n{summary}\n\n", meta.frame_id, meta.timestamp, meta.application, meta.title));
        out.push_str(&format!("Application: {}  bundle={}  pid={}\nCaptured: {}\n", meta.application, meta.bundle, meta.pid, meta.captured_utc));
        out.push_str(&format!("Nodes: total={} text={text_nodes} depth={}\n", meta.node_count, depth(tree)));
        if !filters.is_empty() {
            out.push_str(&format!("Filters: {filters}\n"));
        }
        out.push('\n');
        human(&root, 0, &mut out);
    } else {
        out.push_str(&format!("<!-- Frame {} | {} | {} | {} | {summary} -->\n", meta.frame_id, meta.timestamp, meta.application, meta.title));
        let mut head = format!(
            "<AccessibilityTree application=\"{}\" bundle=\"{}\" pid=\"{}\" captured=\"{}\" total_nodes=\"{}\" text_nodes=\"{text_nodes}\" depth=\"{}\" partial_tree=\"{}\"",
            esc(&meta.application), esc(&meta.bundle), meta.pid, meta.captured_utc, meta.node_count, depth(tree), meta.partial
        );
        if !filters.is_empty() {
            head.push_str(&format!(" filters=\"{filters}\""));
        }
        out.push_str(&format!("{head}>\n"));
        xml(&root, 1, &mut out);
        out.push_str("</AccessibilityTree>\n");
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tree() -> Value {
        json!({"role": "AXWindow", "title": "Doc", "x": 0, "y": 0, "w": 100, "h": 80, "children": [
            {"role": "AXGroup", "children": [
                {"role": "AXButton", "title": "Save", "x": 1, "y": 2, "w": 3, "h": 4},
                {"role": "AXStaticText", "value": "Hello & <bye>"}]},
            {"role": "AXGroup", "hidden": true, "children": [{"role": "AXStaticText", "value": "offscreen"}]},
            {"role": "AXScrollArea", "children": [{"role": "AXLink", "description": "Docs", "url": "https://example.com"}]}
        ]})
    }

    fn meta() -> AxMeta {
        AxMeta {
            frame_id: 7, timestamp: "2026-01-01T10:00:00".into(), application: "Editor".into(), title: "Doc".into(),
            bundle: "com.example.editor".into(), pid: 42, captured_utc: "2026-01-01T09:00:00Z".into(),
            node_count: 7, stored_bytes: 100, partial: false,
        }
    }

    #[test]
    fn default_drops_hidden_coords_and_wrappers() {
        let out = render(&tree(), &meta(), &AxOpts::default());
        assert!(out.starts_with("<!-- Frame 7 | 2026-01-01T10:00:00 | Editor | Doc | nodes=7"));
        assert!(out.contains("<AccessibilityTree application=\"Editor\" bundle=\"com.example.editor\" pid=\"42\""));
        assert!(!out.contains("offscreen"), "hidden subtree dropped");
        assert!(!out.contains("AXGroup"), "wrappers collapse");
        assert!(!out.contains(" x=\""), "no coordinates by default");
        assert!(out.contains("<AXStaticText value=\"Hello &amp; &lt;bye&gt;\"/>"));
        assert!(out.contains("<AXLink desc=\"Docs\" url=\"https://example.com\"/>"));
    }

    #[test]
    fn raw_is_verbatim() {
        let out = render(&tree(), &meta(), &AxOpts { raw: true, ..Default::default() });
        assert!(out.contains("<AXGroup>") && out.contains("offscreen") && out.contains("x=\"1\" y=\"2\" w=\"3\" h=\"4\""));
    }

    #[test]
    fn human_text_only_roles_and_depth() {
        let h = render(&tree(), &meta(), &AxOpts { human: true, text_only: true, coords: true, ..Default::default() });
        assert!(h.contains("[AXButton] \"Save\" @(1,2) 3x4"));
        assert!(h.contains("Filters: coords=on text_only=on"));
        assert!(!h.contains("AXScrollArea"));
        let r = render(&tree(), &meta(), &AxOpts { roles: vec!["AXLink".into()], ..Default::default() });
        assert!(r.contains("AXLink") && !r.contains("AXButton") && r.contains("<AXApplication"));
        let d = render(&tree(), &meta(), &AxOpts { max_depth: Some(1), ..Default::default() });
        assert!(d.contains("<AXWindow title=\"Doc\" truncated=\""));
    }
}
